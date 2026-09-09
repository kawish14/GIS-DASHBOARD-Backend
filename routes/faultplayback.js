const express = require("express");
const router = express.Router();
const { webappPool } = require("../db/db");
const { isAuthenticated } = require("./auth");

const SPATIAL_TABLE = 'sde."nce_gis_alerts"';
const SPATIAL_JOIN_KEY = "c.alias = h.alias";

const NUM_BINS = 40;

function parseBbox(bbox) {
  const { xmin, ymin, xmax, ymax } = bbox || {};
  const nums = [xmin, ymin, xmax, ymax].map(Number);
  if (nums.some((n) => Number.isNaN(n))) return null;
  return { xmin: nums[0], ymin: nums[1], xmax: nums[2], ymax: nums[3] };
}

/**
 * POST /nce/faults/histogram
 * body: { daysAgo: number, bbox: {xmin,ymin,xmax,ymax} }
 * 
 * Returns 40 pre-counted time buckets tracking both fault occurrences 
 * and fault resolutions (clears) for the current map extent + window.
 */
router.post("/histogram", isAuthenticated, async (req, res) => {
  const bbox = parseBbox(req.body.bbox);
  const days = parseInt(req.body.daysAgo, 10);

  if (!bbox || !Number.isFinite(days) || days < 1 || days > 30) {
    return res.status(400).json({ error: "Invalid daysAgo or bbox" });
  }

  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const startEpoch = startMs / 1000;
  const endEpoch = endMs / 1000;

  try {
    const sql = `
      WITH combined AS (
        SELECT h.fault_time AS event_time, 'fault' AS event_type
        FROM sde.nce_alerts_history h
        JOIN ${SPATIAL_TABLE} c ON ${SPATIAL_JOIN_KEY}
        WHERE h.fault_time >= to_timestamp($1)
          AND h.fault_time <= to_timestamp($2)
          AND ST_Intersects(c.shape, ST_MakeEnvelope($3, $4, $5, $6, 3857))
        UNION ALL
        SELECT h.fault_time_clear AS event_time, 'clear' AS event_type
        FROM sde.nce_alerts_history h
        JOIN ${SPATIAL_TABLE} c ON ${SPATIAL_JOIN_KEY}
        WHERE h.fault_time_clear IS NOT NULL
          AND h.fault_time_clear >= to_timestamp($1)
          AND h.fault_time_clear <= to_timestamp($2)
          AND ST_Intersects(c.shape, ST_MakeEnvelope($3, $4, $5, $6, 3857))
      )
      SELECT
        width_bucket(extract(epoch FROM event_time), $1, $2, $7) AS bin,
        sum(CASE WHEN event_type = 'fault' THEN 1 ELSE 0 END)::int AS fault_count,
        sum(CASE WHEN event_type = 'clear' THEN 1 ELSE 0 END)::int AS clear_count
      FROM combined
      GROUP BY bin
      ORDER BY bin
    `;
    const params = [startEpoch, endEpoch, bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax, NUM_BINS];
    const { rows } = await webappPool.query(sql, params);

    const binSize = (endMs - startMs) / NUM_BINS;
    const faultCounts = new Map(rows.map((r) => [r.bin, r.fault_count]));
    const clearCounts = new Map(rows.map((r) => [r.bin, r.clear_count]));

    const bins = Array.from({ length: NUM_BINS }, (_, i) => ({
      binStart: startMs + i * binSize,
      binEnd: startMs + (i + 1) * binSize,
      faultCount: faultCounts.get(i + 1) || 0,
      clearCount: clearCounts.get(i + 1) || 0,
    }));

    res.json({ bins, start: startMs, end: endMs });
  } catch (err) {
    console.error("Error computing fault histogram:", err);
    res.status(500).json({ error: "Failed to compute fault histogram" });
  }
});

/**
 * POST /nce/faults/hotspots
 * body: { daysAgo: number, bbox: {xmin,ymin,xmax,ymax}, alarmstate?: number, limit?: number }
 */
router.post("/hotspots", isAuthenticated, async (req, res) => {
  const bbox = parseBbox(req.body.bbox);
  const days = parseInt(req.body.daysAgo, 10);
  const alarmstate = req.body.alarmstate ? parseInt(req.body.alarmstate, 10) : null;
  const limit = Math.min(parseInt(req.body.limit, 10) || 15, 50);

  if (!bbox || !Number.isFinite(days)) {
    return res.status(400).json({ error: "Invalid daysAgo or bbox" });
  }

  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;

  try {
    const params = [
      new Date(startMs),
      new Date(endMs),
      bbox.xmin,
      bbox.ymin,
      bbox.xmax,
      bbox.ymax,
      limit,
    ];
    let alarmClause = "";
    if (alarmstate) {
      alarmClause = "AND h.alarmstate = $8";
      params.push(alarmstate);
    }

    const sql = `
      SELECT
        c.olt,
        c.splitter_id,
        count(*)::int AS fault_count,
        count(DISTINCT h.alias)::int AS distinct_customers,
        min(h.fault_time) AS first_fault,
        max(h.fault_time) AS last_fault,
        extract(epoch FROM (max(h.fault_time) - min(h.fault_time))) AS span_seconds,
        avg(coalesce(h.outage_duration, 0))::numeric(10,1) AS avg_outage_minutes,
        ST_X(ST_Centroid(ST_Collect(c.shape))) AS centroid_x,
        ST_Y(ST_Centroid(ST_Collect(c.shape))) AS centroid_y
      FROM sde.nce_alerts_history h
      JOIN ${SPATIAL_TABLE} c ON ${SPATIAL_JOIN_KEY}
      WHERE h.fault_time >= $1
        AND h.fault_time <= $2
        AND ST_Intersects(c.shape, ST_MakeEnvelope($3, $4, $5, $6, 3857))
        ${alarmClause}
      GROUP BY c.olt, c.splitter_id
      HAVING count(DISTINCT h.alias) > 1
      ORDER BY distinct_customers DESC, fault_count DESC
      LIMIT $7
    `;
    const { rows } = await webappPool.query(sql, params);
    res.json({ hotspots: rows });
  } catch (err) {
    console.error("Error computing fault hotspots:", err);
    res.status(500).json({ error: "Failed to compute fault hotspots" });
  }
});

module.exports = router;