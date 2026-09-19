// Lancé toutes les 3h par .github/workflows/refresh-news.yml (GitHub Actions) — jamais sur
// Vercel, jamais déclenché par un visiteur du site. Il récupère des news de marché brutes
// chez Alpha Vantage, demande à Claude de les ranger dans les facteurs existants de MacroMap,
// FUSIONNE le résultat avec ce qui est déjà dans public/live-news.json (pour que les news
// ne disparaissent pas au run suivant), puis réécrit le fichier.
//
// Le site ne lit que ce fichier statique (voir refreshLiveNews() dans src/App.jsx) : il
// n'appelle jamais Alpha Vantage ni Claude. Le quota gratuit (25 requêtes/jour) ne dépend donc
// pas du trafic : ce script fait 2 appels Alpha Vantage par run (voir pickTopics), 8 runs/jour.
//
// Secrets requis (GitHub → Settings → Secrets and variables → Actions) :
//   ALPHA_VANTAGE_API_KEY
//   ANTHROPIC_API_KEY

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAX_AGE_DAYS,
  MAX_SEEN,
  pickTopics,
  parseAvTime,
  extractJson,
  mergeNews,
  buildFreshByFactor,
} from "./news-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "public", "live-news.json");

const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ALPHA_VANTAGE_API_KEY || !ANTHROPIC_API_KEY) {
  console.error("ALPHA_VANTAGE_API_KEY ou ANTHROPIC_API_KEY manquante — arrêt sans toucher à live-news.json.");
  process.exit(1);
}

// Les ids de facteurs exacts déjà utilisés par MacroMap (voir NODE_NEWS / NODE_CONTEXT dans
// src/App.jsx). Claude ne range un article que sous l'un de ces ids — ce qui ne correspond
// clairement à aucun est ignoré plutôt que forcé.
const FACTORS = [
  ["gold", "Gold / XAUUSD (overall)"],
  ["g-real-yields", "Real yields (Gold factor)"],
  ["g-usd", "USD (Gold factor)"],
  ["g-cb-demand", "Central bank gold buying"],
  ["g-etf-flows", "Gold ETF flows"],
  ["g-safe-haven", "Safe-haven demand (Gold)"],
  ["g-geo-risk", "Geopolitical risk (Gold factor)"],
  ["g-physical-demand", "Physical gold demand (China/India)"],
  ["dxy", "DXY / US Dollar Index"],
  ["usd", "USD (broad)"],
  ["rate-differentials", "Rate differentials (USD factor)"],
  ["ecb-europe", "ECB / Eurozone policy"],
  ["boj-japan", "Bank of Japan policy"],
  ["fed", "Federal Reserve (overall)"],
  ["fomc", "FOMC meeting / decision"],
  ["rate-expectations", "Fed rate-hike/cut expectations"],
  ["cpi", "US CPI inflation"],
  ["core-cpi", "US core CPI"],
  ["pce", "US PCE inflation"],
  ["ppi", "US PPI (producer prices)"],
  ["us10y", "US 10-year Treasury yield"],
  ["real-yields", "Real yields (broad)"],
  ["growth", "US economic growth"],
  ["nfp", "US Non-Farm Payrolls / jobs report"],
  ["labor", "US labor market (broad)"],
  ["equities", "US equities (broad)"],
  ["nasdaq", "Nasdaq 100"],
  ["spx", "S&P 500"],
  ["earnings", "Corporate earnings"],
  ["valuations", "Equity valuations"],
  ["financial-conditions", "Financial conditions"],
  ["bonds", "US Treasuries (broad)"],
  ["treasury-supply", "Treasury issuance / supply"],
  ["oil", "WTI crude oil (overall)"],
  ["oil-geo", "Oil \u2014 geopolitical supply risk"],
  ["oil-opec", "OPEC+ production policy"],
  ["oil-supply", "Global oil supply"],
  ["oil-demand", "Global oil demand"],
  ["oil-inventories", "Oil inventories / stocks"],
  ["btc", "Bitcoin (overall)"],
  ["btc-usd", "USD strength (Bitcoin factor)"],
  ["btc-real-yields", "Real yields (Bitcoin factor)"],
  ["btc-risk-appetite", "Risk appetite (Bitcoin factor)"],
  ["btc-etf-flows", "Bitcoin ETF flows"],
  ["btc-crypto-liquidity", "Crypto-specific liquidity / stablecoins"],
  ["btc-regulation", "US crypto regulation (CLARITY Act etc.)"],
  ["middle-east", "Middle East geopolitical tensions"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTopic(topic) {
  const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${encodeURIComponent(topic)}&sort=LATEST&limit=50&apikey=${ALPHA_VANTAGE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const data = await res.json();
  if (data.Note || data.Information || data["Error Message"]) {
    // Quota dépassé, clé refusée, etc. — on le dit clairement plutôt que d'écrire du vide.
    throw new Error(`Alpha Vantage a refusé la requête : ${data.Note || data.Information || data["Error Message"]}`);
  }
  const feed = Array.isArray(data.feed) ? data.feed : [];
  return feed.map((a) => ({
    title: a.title,
    url: a.url,
    source: a.source,
    time_published: a.time_published, // ex. 20260912T143000 (UTC)
    summary: a.summary,
  }));
}

async function readPrevious() {
  try {
    const raw = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
    return {
      byFactor: raw && typeof raw.byFactor === "object" && raw.byFactor ? raw.byFactor : {},
      seen: Array.isArray(raw?.seen) ? raw.seen : [],
    };
  } catch {
    return { byFactor: {}, seen: [] };
  }
}

async function classifyWithClaude(articles) {
  const factorList = FACTORS.map(([id, label]) => `${id}: ${label}`).join("\n");
  const articleList = articles.map((a, i) => `[${i}] (${a.source}, ${a.time_published}) ${a.title}\nURL: ${a.url}\nSummary: ${a.summary}`).join("\n\n");

  const system = `Tu es le module de classement des actualités de MacroMap, une application de suivi macro. On te donne une liste de facteurs macro/marché existants et une liste d'articles bruts. Pour chaque article clairement pertinent pour au moins un facteur, choisis le ou les facteurs les plus précis (jamais plus de 2), et écris une version COURTE, PARAPHRASÉE EN FRANÇAIS (jamais une copie du titre original) avec : un titre court, un résumé (1-2 phrases), et une explication de pourquoi c'est pertinent pour ce facteur (1 phrase). Ignore les articles qui ne correspondent clairement à aucun facteur de la liste — n'invente jamais de correspondance forcée. Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, de la forme :
{"gold": [{"headline": "...", "summary": "...", "why": "...", "articleIndex": 0}], "cpi": [...]}
Les clés doivent être exclusivement parmi les identifiants de facteurs fournis. Maximum 2 articles par facteur, ne garde que les plus pertinents.`;

  const user = `FACTEURS DISPONIBLES:\n${factorList}\n\nARTICLES (index entre crochets):\n${articleList}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.stop_reason === "max_tokens") throw new Error("réponse de Claude tronquée (max_tokens) — réduis le nombre d'articles envoyés");
  const text = (data.content || []).map((b) => b.text || "").join("\n");
  return extractJson(text);
}

async function main() {
  const now = new Date();
  const prev = await readPrevious();
  const topics = pickTopics(now);
  console.log(`Topics de ce run : ${topics.join(", ")}`);

  // 1) Alpha Vantage — un topic par appel. Si un appel échoue mais qu'un autre réussit,
  //    on continue avec ce qu'on a ; si tout échoue, on s'arrête sans rien écraser.
  const collected = [];
  let okCalls = 0;
  let lastError = null;
  for (const [i, topic] of topics.entries()) {
    if (i > 0) await sleep(1500); // limite gratuite : 5 requêtes/minute
    try {
      const feed = await fetchTopic(topic);
      console.log(`  ${topic} : ${feed.length} articles`);
      collected.push(...feed);
      okCalls++;
    } catch (err) {
      lastError = err;
      console.error(`  ${topic} : échec — ${err.message}`);
    }
  }
  if (okCalls === 0) throw lastError || new Error("aucun appel Alpha Vantage n'a réussi");

  // 2) Dédoublonnage, retrait des articles déjà traités ou trop vieux, plus récents d'abord.
  const cutoff = now.getTime() - MAX_AGE_DAYS * 86400000;
  const seenSet = new Set(prev.seen);
  const unique = new Map();
  for (const a of collected) {
    if (!a.url || unique.has(a.url)) continue;
    unique.set(a.url, a);
  }
  const fresh = [...unique.values()]
    .filter((a) => !seenSet.has(a.url))
    .filter((a) => {
      const iso = parseAvTime(a.time_published);
      return iso && Date.parse(iso) >= cutoff;
    })
    .sort((a, b) => (b.time_published || "").localeCompare(a.time_published || ""))
    .slice(0, 45);
  console.log(`${unique.size} articles uniques, ${fresh.length} nouveaux à classer.`);

  // 3) Classement par Claude (uniquement s'il y a du nouveau — inutile de payer sinon).
  let freshByFactor = {};
  if (fresh.length > 0) {
    const classification = await classifyWithClaude(fresh);
    freshByFactor = buildFreshByFactor(classification, fresh, FACTORS.map(([id]) => id));
  }

  // 4) Fusion avec l'existant, puis écriture. updatedAt = dernière vérification réussie
  //    (même s'il n'y avait rien de neuf) : c'est ce que le badge du site affiche.
  const byFactor = mergeNews(prev.byFactor, freshByFactor, now);
  const seen = [...fresh.map((a) => a.url), ...prev.seen].slice(0, MAX_SEEN);
  const output = { updatedAt: now.toISOString(), byFactor, seen };
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`OK — ${Object.keys(freshByFactor).length} facteurs avec du nouveau, ${Object.keys(byFactor).length} facteurs avec des news au total.`);
}

main().catch((err) => {
  console.error("refresh-news a échoué :", err.message);
  process.exit(1);
});
