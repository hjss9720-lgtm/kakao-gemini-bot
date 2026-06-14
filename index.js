const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const app = express();
app.use(express.json());

const G_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MODEL = "gemini-2.5-flash-lite";
const EMBED_MODEL = "models/gemini-embedding-001";

app.get("/", (req, res) => {
  res.send("Vercel Gemini RAG Bot is Active! 🚀");
});

app.post("/webhook", async (req, res) => {
  const userMsg = req.body.userRequest?.utterance || "";

  try {
    const reply = await runRAGGemini(userMsg);
    return res.json(kakaoResponse(reply));
  } catch (e) {
    console.error("Error:", e);
    return res.json(kakaoResponse("죄송해요, 잠시 후 다시 시도해주세요."));
  }
});

async function getEmbedding(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:embedContent?key=${G_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY"
    })
  });
  const data = await res.json();
  console.log("임베딩 결과:", data.embedding ? "성공" : JSON.stringify(data));
  return data.embedding?.values || null;
}

async function searchFAQ(embedding) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_faq`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_threshold: 0.5,
      match_count: 3
    })
  });
  const data = await res.json();
  console.log("Supabase 응답:", JSON.stringify(data));
  return Array.isArray(data) ? data : [];
}

async function runRAGGemini(msg) {
  const embedding = await getEmbedding(msg);

  let contextText = "";
  if (embedding) {
    const matches = await searchFAQ(embedding);
    console.log("FAQ matches:", matches.length);
    if (matches.length > 0) {
      contextText = matches
        .map(m => `Q: ${m.question}\nA: ${m.answer}`)
        .join("\n\n");
    }
  }

  console.log("컨텍스트 사용 여부:", contextText ? "있음" : "없음");

  const systemPrompt = `당신은 한중에스에스 고객 상담 챗봇입니다.
답변 규칙:
- 반드시 3문장 이내로 짧고 명확하게 답변
- 불필요한 인사말/마무리 멘트 금지
- 아래 회사 자료가 있으면 우선 참고하고, 없으면 일반 지식으로 답변

[회사 자료]
${contextText || "관련 자료 없음"}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${G_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: msg }] }],
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.5
      }
    })
  });

  const data = await response.json();
  console.log("Gemini 응답:", JSON.stringify(data));
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "답변을 가져오지 못했어요.";
}

function kakaoResponse(text) {
  return {
    version: "2.0",
    template: { outputs: [{ simpleText: { text } }] }
  };
}

module.exports = app;
