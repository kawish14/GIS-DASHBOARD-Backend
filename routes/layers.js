const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const { DOMParser } = require("xmldom");
const cron = require("node-cron");

const listLayer = async () => {
    const url = `${api}/geoserver/wms?service=WMS&version=1.1.1&request=GetCapabilities`;

    const layerNames = [];
    const layerTitles = [];
    const response = await fetch(url);
    const data = await response.text();

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(data, "text/xml");

    const layers = xmlDoc.getElementsByTagName("Layer");

    for (let i = 1; i < layers.length; i++) {
        const nameElement = layers[i].getElementsByTagName("Name")[0];
        const titleElement = layers[i].getElementsByTagName("Title")[0];

        if (nameElement && titleElement) {
        const name = nameElement.textContent;
        const title = titleElement.textContent;

        if (name.startsWith("web") || name.startsWith("twa")) {
            layerNames.push(name);
            layerTitles.push(title);
        }
        }
    }

    return { layerNames, layerTitles }
};


let cachedLayers = null;

// Run once per day at 02:00 AM
cron.schedule("0 2 * * *", async () => {
  console.log("Running daily GeoServer layer fetch...");
  try {
    cachedLayers = await listLayer();
    console.log("Layer list updated");
  } catch (err) {
    console.error("Daily layer fetch failed:", err);
  }
});

router.get("/layers", (req, res) => {
  if (!cachedLayers) {
    return res.status(503).json({ error: "Layers not loaded yet" });
  }
  res.json(cachedLayers);
});

module.exports = router;
