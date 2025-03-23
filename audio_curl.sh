#!/bin/bash
curl https://api.openai.com/v1/audio/speech \
-H "Authorization: Bearer $OPENAI_API_KEY" \
-H "Content-Type: application/json" \
-d '{
  "model": "gpt-4o-mini-tts",
  "input": "Besides administering standardized pre-college tests, Americas nonprofit College Board designs college-level classes that high school students can take. But now theyre also crafting courses not just with higher education at the table, but industry partners such as the U.S. Chamber of Commerce and the technology giant IBM, reports Education Week. ",
  "voice": "coral",
  "instructions": "Read this in a tone that is like NPR."
}' \
--output speech.mp3
