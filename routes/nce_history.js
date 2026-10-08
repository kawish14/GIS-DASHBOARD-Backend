const express = require("express");
const router = express.Router();
// Import the webapp pool we created earlier
const { webappPool } = require("../db/db"); 
const { isAuthenticated } = require("./auth");
const { logActivity, ACTIONS } = require("../utils/activityLog");

// Alarm diagnostics for the map's filter panel.
//
// Called by features/filters/widgets/AlarmAnalyticsFilter.jsx -- the only
// route here with a caller. Three others (GET /nce-history,
// POST /nce-history/lop-repeats, GET /nce-history/customer/:alias) were
// removed as unused; recover them from git history if a screen needs them.
router.post("/nce-history/advanced-analytics", isAuthenticated, async (req, res) => {
  try {
    const { 
      alarmstate = 4, 
      days = 10, 
      minDuration = 10, 
      minRepeats = 2,
      region = []   
    } = req.body;


    const queryParams = [
      parseInt(alarmstate, 10), 
      parseInt(days, 10), 
      parseInt(minDuration, 10), 
      parseInt(minRepeats, 10)
    ];

    const queryParamsBroad = [
      parseInt(alarmstate, 10), 
      parseInt(days, 10)
    ];

    // Dynamic Region Filter Clauses & Parameter Indexing
    let regionClauseQ1 = "";
    let regionClauseQ2 = "";

    if (Array.isArray(region) && region.length > 0) {
      // Add region to queryParams (index 5)
      queryParams.push(region);
      regionClauseQ1 = ` AND region = ANY($${queryParams.length})`;

      // Add region to queryParamsBroad (index 3)
      queryParamsBroad.push(region);
      const broadIdx = queryParamsBroad.length;
      regionClauseQ2 = ` AND z.region = ANY($${broadIdx})`; // filters via zone region
    }

    // 1. Customer Outage Summary
    const q1_summary = `
      SELECT 
        h.alias, 
        alarminfo,
        COUNT(*) AS total_occurrences, 
        MIN(h.fault_time) AS first_alarm, 
        MAX(h.fault_time) AS last_alarm,
        EXTRACT(DAY FROM (MAX(CAST(h.fault_time AS timestamp)) - MIN(CAST(h.fault_time AS timestamp)))) AS total_whole_days,
        SUM(COALESCE(h.outage_duration, 0)) AS total_down_minutes,
        ROUND(AVG(COALESCE(h.outage_duration, 0)), 1) AS avg_down_minutes,
        MAX(COALESCE(h.outage_duration, 0)) AS max_single_outage,
        SUM(CASE WHEN h.fault_time_clear IS NULL THEN 1 ELSE 0 END) AS current_status
      FROM sde.nce_alerts_history h
      JOIN sde.customer c ON h.alias = c.id
      WHERE h.alarmstate = $1 
        AND CAST(h.fault_time AS timestamp) >= NOW() - ($2 * INTERVAL '1 day')
        AND (COALESCE(h.outage_duration, 0) >= $3)
        ${regionClauseQ1}
      GROUP BY h.alias, h.alarminfo
      HAVING COUNT(*) >= $4
      ORDER BY total_occurrences DESC;
    `;

    // 2. Spatial Vulnerability by Zone
    const q2_zones = `
      SELECT 
        z.zone,
        z.region,
        STRING_AGG(DISTINCT z.area, ', ') AS area,
        COUNT(h.*) AS total_alarms,
        COUNT(DISTINCT h.alias) AS affected_customers,
        ARRAY_AGG(DISTINCT h.alias) AS affected_aliases 
      FROM sde.nce_gis_alerts h
      JOIN sde.zones z ON ST_Intersects(
        ST_SetSRID(h.shape, 4326), 
        ST_SetSRID(z.shape, 4326)
      )
      WHERE h.alarmstate = $1 
        AND CAST(h.fault_time AS timestamp) >= NOW() - ($2 * INTERVAL '1 day')
        ${regionClauseQ2}
      GROUP BY z.zone, z.region
      ORDER BY zone;
    `;

    const [resSummary, resZones] = await Promise.all([
      webappPool.query(q1_summary, queryParams),
      webappPool.query(q2_zones, queryParamsBroad)
    ]);

    // Which filters people actually use -- worth knowing before changing them.
    logActivity(req, ACTIONS.NCE_ANALYTICS, {
      details: { alarmstate, days, minDuration, minRepeats, region, results: resSummary.rowCount },
    });

    res.json({
      success: true,
      data: {
        summaryByAlias: resSummary.rows,
        alarmsByZone: resZones.rows,
      }
    });
  } catch (err) {
    console.error("Error executing advanced alarm analytics:", err);
    res.status(500).json({ success: false, error: "Failed to execute analytical queries" });
  }
});
module.exports = router;
