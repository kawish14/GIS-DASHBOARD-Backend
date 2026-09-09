const express = require('express');
const router = express.Router();
require('dotenv').config(); // Load variables from .env
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize the Gemini API client
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use gemini-2.5-flash for fast text and multimodal responses
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Context to keep the AI focused on your specific domain
const SYSTEM_INSTRUCTION = `
You are an AI assistant embedded in a GIS dashboard for telecommunications network management.
The user is tracking GPON network inventory (FAT, Joints, Feeder, Distribution) and live vehicles.
Keep your answers concise, helpful, and focused on network operations.
`;

// POST route for the chat interface
// POST route for the chat interface
router.post('/chat', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const prompt = `${SYSTEM_INSTRUCTION}\n\nUser Question: ${query}`;
    
    let text = "";
    let retries = 3;
    let delay = 1000; // Start with a 1-second delay

    // Retry loop
    while (retries > 0) {
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        text = response.text();
        break; // If successful, break out of the loop
      } catch (apiError) {
        // If it's a 503 error and we have retries left
        if (apiError.status === 503 && retries > 1) {
          console.warn(`Gemini API busy. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retries--;
          delay *= 2; // Double the delay for the next attempt (2s, 4s...)
        } else {
          // If it's a different error or we ran out of retries, throw it
          throw apiError;
        }
      }
    }

    // Send the successful reply back to the React frontend
    res.json({ reply: text });

  } catch (error) {
    console.error("Error communicating with Gemini API:", error);
    res.status(500).json({ 
      reply: "The AI is currently experiencing high traffic. Please try again in a moment.",
      error: error.message 
    });
  }
});

module.exports = router;