const express = require("express");
const router = express.Router();
const { webappPool } = require("../db/db");
const { isAuthenticated } = require("./auth");

// 1. Raw listing (mirrors nce_history's raw route) -- mostly useful for
//    debugging / admin views, not for the dashboards themselves.
router.get("/customer-service", isAuthenticated, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const result = await webappPool.query(
      "SELECT * FROM sde.customer_service ORDER BY status_change_date DESC NULLS LAST LIMIT $1",
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching customer_service:", err);
    res.status(500).json({ error: "Failed to fetch customer service data" });
  }
});

// 2. Single lookup by alias (the table's unique key, same alias used
//    everywhere else -- Customers_test.alias, nce_alerts_history.alias).
router.get("/customer-service/:alias", isAuthenticated, async (req, res) => {
  try {
    const result = await webappPool.query(
      "SELECT * FROM sde.customer_service WHERE alias = $1",
      [req.params.alias]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No customer_service record for that alias" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching customer_service by alias:", err);
    res.status(500).json({ error: "Failed to fetch customer service record" });
  }
});

// 3. Bulk lookup -- this is the one the dashboards actually want: given a
//    page of aliases pulled from the ArcGIS layer, fetch the authoritative
//    service/billing fields for exactly those customers in one round trip
//    instead of N single lookups.
router.post("/customer-service/bulk", isAuthenticated, async (req, res) => {
  try {
    const { aliases } = req.body;
    if (!Array.isArray(aliases) || aliases.length === 0) {
      return res.status(400).json({ error: "Body must include a non-empty 'aliases' array" });
    }
    // Guard against pathologically large joins from a bad client bug.
    const capped = aliases.slice(0, 5000);
    const result = await webappPool.query(
      "SELECT * FROM sde.customer_service WHERE alias = ANY($1)",
      [capped]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching customer_service bulk:", err);
    res.status(500).json({ error: "Failed to fetch customer service records" });
  }
});

// 4. Aggregate stats for the Service Mix dashboard. Does the grouping in
//    Postgres instead of dragging the whole table to the browser -- this
//    table is the same order of magnitude as Customers_test (six figures).
//
//    status_change_date/activation_date are stored as varchar in
//    DD-MM-YYYY format (confirmed from sample data), not a real date type,
//    so every date comparison below validates the pattern with a regex
//    before casting -- an un-castable value just gets excluded from the
//    date-based numbers instead of throwing.
const DATE_PATTERN = "^\\d{2}-\\d{2}-\\d{4}$";
const CAST_STATUS_DATE = `CASE WHEN status_change_date ~ '${DATE_PATTERN}' THEN TO_DATE(status_change_date, 'DD-MM-YYYY') END`;

// Add-on package columns come through as literal string junk in places
// ("0.0", "NaN", "", null) rather than a clean boolean -- this is the
// "does the customer actually have this add-on" test used everywhere below.
const HAS_ADDON = (col) => `${col} IS NOT NULL AND ${col} NOT IN ('0.0', '0', 'NaN', 'nan', '')`;

router.get("/customer-service/stats", isAuthenticated, async (req, res) => {
  try {
    const [totals, tierBreakdown, packageBreakdown, statusBreakdown, recentChanges] = await Promise.all([
      webappPool.query(`
        SELECT
          count(*) AS total,
          count(*) FILTER (WHERE status = 'Active') AS active_total,
          count(*) FILTER (WHERE ${HAS_ADDON("voice_package")}) AS voice_addon,
          count(*) FILTER (WHERE ${HAS_ADDON("iptv_package")}) AS iptv_addon,
          count(*) FILTER (WHERE ${HAS_ADDON("tru_tv_package")}) AS tv_addon,
          count(*) FILTER (WHERE ${CAST_STATUS_DATE} >= CURRENT_DATE - INTERVAL '30 days') AS changed_last_30d
        FROM sde.customer_service
      `),
      webappPool.query(`
        SELECT COALESCE(service_tier, 'Unknown') AS service_tier, count(*) AS count
        FROM sde.customer_service
        GROUP BY service_tier
        ORDER BY count DESC
      `),
      webappPool.query(`
        SELECT COALESCE(package, 'Unknown') AS package, count(*) AS count
        FROM sde.customer_service
        GROUP BY package
        ORDER BY count DESC
        LIMIT 15
      `),
      webappPool.query(`
        SELECT COALESCE(status, 'Unknown') AS status, count(*) AS count
        FROM sde.customer_service
        GROUP BY status
        ORDER BY count DESC
      `),
      webappPool.query(`
        SELECT alias, status, status_change_date, ${CAST_STATUS_DATE} AS parsed_date
        FROM sde.customer_service
        WHERE status_change_date ~ '${DATE_PATTERN}'
        ORDER BY ${CAST_STATUS_DATE} DESC
        LIMIT 25
      `),
    ]);

    res.json({
      totals: totals.rows[0],
      tierBreakdown: tierBreakdown.rows,
      packageBreakdown: packageBreakdown.rows,
      statusBreakdown: statusBreakdown.rows,
      recentChanges: recentChanges.rows,
    });
  } catch (err) {
    console.error("Error fetching customer_service stats:", err);
    res.status(500).json({ error: "Failed to fetch customer service stats" });
  }
});

module.exports = router;