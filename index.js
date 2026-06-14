const express = require("express");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
const app = express();
app.use(express.json());

const G_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MODEL = "gemini-2.5-flash-lite";
const EMBED_MODEL = "models/gemini-embedding-001";

// 사용자별 대화 히스토리 저장
const userHistory = new Map();

app.get("/", (req, res) => {
  res.send("Vercel Gemini RAG Bot is Active! 🚀");
});

app.post("/webhook", async (req, res) => {
  const userId = req.body.userRequest?.user?.id || "unknown";
  const userMsg = req.body.userRequest?.utterance || "";

  try {
    const reply = await runRAGGemini(userId, userMsg);
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
  return Array.isArray(data) ? data : [];
}

async function runRAGGemini(userId, msg) {
  // 히스토리 가져오기 (없으면 빈 배열)
  const history = userHistory.get(userId) || [];

  // RAG 검색
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

  const systemPrompt = `당신은 한중에스에스 고객 상담 챗봇입니다.
답변 규칙:
- 반드시 3문장 이내로 짧고 명확하게 답변
- 불필요한 인사말/마무리 멘트 금지
- 이전 대화 내용을 기억하고 연계하여 답변
- 아래 회사 자료가 있으면 우선 참고하고, 없으면 일반 지식으로 답변

[회사 자료]
${contextText || "관련 자료 없음"}`;

  // 현재 메시지를 히스토리에 추가
  history.push({ role: "user", parts: [{ text: msg }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${G_KEY}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: history, // 전체 히스토리 전달
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.5
      }
    })
  });

  const data = await response.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "답변을 가져오지 못했어요.";

  // 답변도 히스토리에 추가
  history.push({ role: "model", parts: [{ text: reply }] });

  // 히스토리 최대 10턴으로 제한 (너무 길어지면 토큰 초과)
  if (history.length > 20) history.splice(0, 2);

  // 히스토리 저장 (30분 후 자동 삭제)
  userHistory.set(userId, history);
  setTimeout(() => userHistory.delete(userId), 1800000);

  return reply;
}

function kakaoResponse(text) {
  return {
    version: "2.0",
    template: { outputs: [{ simpleText: { text } }] }
  };
}

module.exports = app;
