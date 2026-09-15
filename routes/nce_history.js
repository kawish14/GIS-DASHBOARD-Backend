const express = require("express");
const router = express.Router();
// Import the webapp pool we created earlier
const { webappPool } = require("../db/db"); 
const { isAuthenticated } = require("./auth");

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
// Restoration trend: what the fault log did over a window, rather than what it
// says right now.
//
// Called by features/analytics/RestorationTrend.jsx. The rest of the dashboard
// -- the alarm sidebar, FaultAnalytics, the map itself -- is a snapshot of this
// instant, which answers "what is broken?" but never "are we gaining on it?".
// That question is raised-vs-cleared per day plus how long a restore takes, and
// both live in sde.nce_alerts_history.
//
// Only columns this file already relies on elsewhere are used here: alias,
// fault_time, fault_time_clear, outage_duration, and region off the customer
// join. fault_time is CAST like it is in the query above -- it is stored as
// text, and comparing it to NOW() without the cast sorts it as a string.
router.post("/nce-history/restoration-trend", isAuthenticated, async (req, res) => {
  try {
    const { days = 14, region = [] } = req.body;

    // A window, not an era: this is a trend view, and a year of daily buckets
    // is neither readable nor cheap.
    const windowDays = Math.min(Math.max(parseInt(days, 10) || 14, 1), 90);

    const params = [windowDays];
    let regionClause = "";
    if (Array.isArray(region) && region.length > 0) {
      params.push(region);
      regionClause = ` AND c.region = ANY($${params.length})`;
    }

    // Raised per day -- when the alarm came in.
    const q_raised = `
      SELECT
        to_char(date_trunc('day', CAST(h.fault_time AS timestamp)), 'YYYY-MM-DD') AS day,
        COUNT(*) AS raised
      FROM sde.nce_alerts_history h
      JOIN sde.customer c ON h.alias = c.id
      WHERE CAST(h.fault_time AS timestamp) >= NOW() - ($1 * INTERVAL '1 day')
        ${regionClause}
      GROUP BY 1
      ORDER BY 1;
    `;

    // Cleared per day, with that day's restore times alongside it. Median as
    // well as mean because one week-long outage drags an average somewhere no
    // actual restore went.
    const q_cleared = `
      SELECT
        to_char(date_trunc('day', CAST(h.fault_time_clear AS timestamp)), 'YYYY-MM-DD') AS day,
        COUNT(*) AS cleared,
        ROUND(AVG(COALESCE(h.outage_duration, 0))::numeric, 1) AS avg_minutes,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(h.outage_duration, 0))::numeric, 1) AS median_minutes
      FROM sde.nce_alerts_history h
      JOIN sde.customer c ON h.alias = c.id
      WHERE h.fault_time_clear IS NOT NULL
        AND CAST(h.fault_time_clear AS timestamp) >= NOW() - ($1 * INTERVAL '1 day')
        ${regionClause}
      GROUP BY 1
      ORDER BY 1;
    `;

    // The same window per region, plus what is still open out of what was
    // raised in it -- the backlog the next shift inherits.
    const q_regions = `
      SELECT
        c.region,
        COUNT(*) AS raised,
        COUNT(*) FILTER (WHERE h.fault_time_clear IS NOT NULL) AS cleared,
        COUNT(*) FILTER (WHERE h.fault_time_clear IS NULL) AS still_open,
        ROUND(AVG(COALESCE(h.outage_duration, 0)) FILTER (WHERE h.fault_time_clear IS NOT NULL)::numeric, 1) AS avg_minutes,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(h.outage_duration, 0))
              FILTER (WHERE h.fault_time_clear IS NOT NULL)::numeric, 1) AS median_minutes
      FROM sde.nce_alerts_history h
      JOIN sde.customer c ON h.alias = c.id
      WHERE CAST(h.fault_time AS timestamp) >= NOW() - ($1 * INTERVAL '1 day')
        ${regionClause}
      GROUP BY c.region
      ORDER BY c.region;
    `;

    const [resRaised, resCleared, resRegions] = await Promise.all([
      webappPool.query(q_raised, params),
      webappPool.query(q_cleared, params),
      webappPool.query(q_regions, params),
    ]);

    res.json({
      success: true,
      data: {
        windowDays,
        raisedByDay: resRaised.rows,
        clearedByDay: resCleared.rows,
        byRegion: resRegions.rows,
      },
    });
  } catch (err) {
    console.error("Error executing restoration trend:", err);
    res.status(500).json({ success: false, error: "Failed to build the restoration trend" });
  }
});

module.exports = router;
