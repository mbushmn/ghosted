import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ------------------------------------------------------------------ */
/*  Storage keys                                                       */
/* ------------------------------------------------------------------ */
const KEY = "applytrace:v1";

/* ------------------------------------------------------------------ */
/*  Pipeline stages — order defines the funnel                         */
/* ------------------------------------------------------------------ */
const STAGES = [
  { id: "saved", label: "Saved", color: "#8B919E" },
  { id: "applied", label: "Applied", color: "#5B5BD6" },
  { id: "interviewing", label: "Interview", color: "#30A46C" },
  { id: "offer", label: "Offer", color: "#F5A524" },
  { id: "rejected", label: "Rejected", color: "#E5484D" },
];
const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s]));

/* ------------------------------------------------------------------ */
/*  GitHub source resolution                                           */
/* ------------------------------------------------------------------ */

// Accepts: full URLs, blob URLs, or bare "owner/repo"
function parseRepo(input) {
  const s = String(input || "").trim().replace(/\.git$/, "");
  if (!s) return null;
  let m = s.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  if (!m) m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], key: `${m[1]}/${m[2]}` };
}

const raw = (o, r, b, p) =>
  `https://raw.githubusercontent.com/${o}/${r}/${b}/${p}`;

// Structured data first, README second. Order matters: dev is the branch
// these repos actually commit automation to.
const JSON_PATHS = [".github/scripts/listings.json", "listings.json"];
const MD_PATHS = ["README.md", "OFFSEASON_README.md", "README-Off-Season.md"];
const BRANCHES = ["dev", "main", "master"];

// Streams so a 12 MB file can report progress instead of looking frozen.
async function tryFetch(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  if (!res.body || !onProgress) return res.text();

  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.length;
    onProgress(bytes);
  }
  const buf = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(buf);
}

/* ---------------------------- JSON parsing ------------------------- */

function fromListingsJson(text, srcKey) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("not an array");

  const visible = data.filter((l) => l && l.title && l.is_visible !== false);

  // These repos never delete — they flip `active` to false and keep the row
  // forever. New-Grad-Positions is ~84% dead listings. Drop them at ingest
  // rather than carrying 15k corpses through every filter and sort.
  const live = visible.filter((l) => l.active !== false && l.url);

  const jobs = live.map((l) => ({
    id: stableId(l.url || `${l.company_name}|${l.title}`),
    company: String(l.company_name || "Unknown").trim(),
    title: cleanText(String(l.title || "")),
    location: Array.isArray(l.locations)
      ? l.locations.join(" · ")
      : String(l.locations || ""),
    url: l.url || "",
    open: true,
    posted: l.date_posted ? Number(l.date_posted) * 1000 : null,
    updated: l.date_updated ? Number(l.date_updated) * 1000 : null,
    ageLabel: "",
    order: 0,
    badges: {
      faang: false,
      advDegree: (l.degrees || []).some((d) => /master|phd|mba/i.test(d)),
      noSponsor: /does not offer sponsorship/i.test(l.sponsorship || ""),
      citizen: /citizenship/i.test(l.sponsorship || ""),
    },
    category: normalizeCategory(l.category),
    sponsorship: l.sponsorship || "",
    source: srcKey,
  }));

  return { jobs, seen: visible.length };
}

/* ------------------------------------------------------------------ */
/*  README parsing                                                     */
/*                                                                     */
/*  These repos render categories as HTML <table> sections, not        */
/*  markdown pipe tables, and each category puts its live rows before  */
/*  a <details> block of archived ones. Parsing the README (rather     */
/*  than listings.json) reproduces the published list exactly:         */
/*  same rows, same categories, same order.                            */
/* ------------------------------------------------------------------ */

const CATEGORY_ORDER = [
  "Software Engineering",
  "Product Management",
  "Data Science, AI & Machine Learning",
  "Quantitative Finance",
  "Hardware Engineering",
  "Other",
];

function cleanText(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/* The raw feed uses a short vocabulary ("Software") while the README renders
   long labels ("Software Engineering"). Fold them so both agree. */
const CATEGORY_ALIASES = {
  software: "Software Engineering",
  "software engineering": "Software Engineering",
  "ai/ml/data": "Data Science, AI & Machine Learning",
  "data science, ai & machine learning": "Data Science, AI & Machine Learning",
  "data science": "Data Science, AI & Machine Learning",
  hardware: "Hardware Engineering",
  "hardware engineering": "Hardware Engineering",
  quant: "Quantitative Finance",
  "quantitative finance": "Quantitative Finance",
  product: "Product Management",
  "product management": "Product Management",
  other: "Other",
};

function normalizeCategory(raw) {
  if (!raw) return "";
  return (
    CATEGORY_ALIASES[String(raw).trim().toLowerCase()] || String(raw).trim()
  );
}

/* These repos scope themselves to US/Canada/Remote, but the raw feed carries
   international roles too. Detect by exclusion so unknowns stay visible. */
const NON_NA =
  /\b(UK|United Kingdom|England|Scotland|Ireland|India|Germany|France|Singapore|Australia|Japan|Poland|Spain|Netherlands|Israel|Brazil|Mexico|China|Sweden|Switzerland|Italy|Korea|Taiwan|UAE|Dubai|Portugal|Denmark|Norway|Finland|Austria|Belgium|Czech|Romania|Hungary|Greece|Turkey|Egypt|Nigeria|Kenya|Argentina|Chile|Colombia|Philippines|Vietnam|Thailand|Malaysia|Indonesia|Hong Kong|New Zealand)\b/i;

function isNorthAmerica(location) {
  if (!location) return true;
  return !NON_NA.test(location);
}

function isRemote(location) {
  return /remote/i.test(location || "");
}

function stripTags(s) {
  return cleanText(
    String(s)
      .replace(/<br\s*\/?>|<\/br>/gi, " · ")
      .replace(/<summary>[\s\S]*?<\/summary>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  ).replace(/^[·\s]+|[·\s]+$/g, "");
}

function readBadges(companyCell, roleCell) {
  const both = `${companyCell} ${roleCell}`;
  return {
    faang: /🔥/.test(companyCell),
    advDegree: /🎓/.test(both),
    noSponsor: /🛂/.test(both),
    citizen: /🇺🇸/.test(both),
  };
}

function cleanCategory(raw) {
  // headers arrive as "💻 Software Engineering New Grad Roles"
  return cleanText(
    String(raw)
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
      .replace(/\b(New Grad|Internship|Intern)\b/gi, "")
      .replace(/\bRoles?\b/gi, "")
  );
}

function fromReadme(md, srcKey) {
  const jobs = [];
  let order = 0;

  const headRe = /^##\s+(.+?)\s*$/gm;
  const heads = [];
  let m;
  while ((m = headRe.exec(md))) heads.push({ title: m[1], start: m.index + m[0].length });

  const sections = heads.length
    ? heads.map((h, i) => ({
        category: cleanCategory(h.title),
        body: md.slice(h.start, i + 1 < heads.length ? heads[i + 1].start : md.length),
      }))
    : [{ category: "", body: md }];

  for (const sec of sections) {
    // everything from the archive marker onward is closed roles
    const cut = sec.body.search(/<summary>\s*🗃️?\s*Inactive roles/i);
    const active = cut >= 0 ? sec.body.slice(0, cut) : sec.body;

    let lastCompany = "";

    // --- HTML table rows ---
    const trRe = /<tr>([\s\S]*?)<\/tr>/g;
    let tr;
    while ((tr = trRe.exec(active))) {
      const tds = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
      if (tds.length < 5) continue;

      let company = stripTags(tds[0]);
      if (!company || /^(↳|->|"|—)$/.test(company)) company = lastCompany;
      else lastCompany = company;

      const title = stripTags(tds[1]);
      if (!company || !title) continue;

      const applyM = tds[3].match(/<a href="([^"]+)"><img[^>]*alt="Apply"/i);
      jobs.push({
        id: stableId(applyM ? applyM[1] : `${company}|${title}`),
        company: company.replace(/^🔥\s*/, ""),
        title,
        location: stripTags(tds[2]),
        url: applyM ? applyM[1] : "",
        open: !/🔒/.test(tds[3]) && Boolean(applyM),
        ageLabel: stripTags(tds[4]),
        posted: null,
        category: sec.category,
        badges: readBadges(tds[0], tds[1]),
        order: order++,
        source: srcKey,
      });
    }

    // --- markdown pipe rows (older forks still use these) ---
    if (!jobs.length || !/<tr>/i.test(active)) {
      for (const rawLine of active.split("\n")) {
        const line = rawLine.trim();
        if (!line.startsWith("|")) continue;
        const bare = line.replace(/\|/g, "").trim();
        if (/^[-:\s]+$/.test(bare)) continue;
        const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (cells.length < 4) continue;
        const first = stripTags(cells[0]);
        if (/^(company|name)$/i.test(first)) continue;

        let company = first;
        if (!company || /^(↳|->|"|—)$/.test(company)) company = lastCompany;
        else lastCompany = company;
        const title = stripTags(cells[1]);
        if (!company || !title) continue;

        const linkM =
          (cells[3] || "").match(/href=["']([^"']+)["']/i) ||
          (cells[3] || "").match(/\]\((https?:\/\/[^)\s]+)\)/);
        jobs.push({
          id: stableId(linkM ? linkM[1] : `${company}|${title}`),
          company: company.replace(/^🔥\s*/, ""),
          title,
          location: stripTags(cells[2] || ""),
          url: linkM ? linkM[1] : "",
          open: Boolean(linkM) && !/🔒/.test(cells[3] || ""),
          ageLabel: stripTags(cells[4] || ""),
          posted: null,
          category: sec.category,
          badges: readBadges(cells[0], cells[1] || ""),
          order: order++,
          source: srcKey,
        });
      }
    }
  }

  return jobs;
}

/* --------------------------- orchestration ------------------------- */

async function loadSource(srcKey, onProgress) {
  const [owner, repo] = srcKey.split("/");

  // README first: it is the published list, already grouped and ordered.
  for (const branch of BRANCHES) {
    for (const path of MD_PATHS) {
      try {
        const text = await tryFetch(raw(owner, repo, branch, path), onProgress);
        const jobs = fromReadme(text, srcKey).filter((j) => j.open);
        if (jobs.length) return { jobs, seen: jobs.length, via: `${path} @ ${branch}` };
      } catch {
        /* next candidate */
      }
    }
  }

  // Fall back to raw data for repos that publish no usable README table.
  for (const branch of BRANCHES) {
    for (const path of JSON_PATHS) {
      try {
        const text = await tryFetch(raw(owner, repo, branch, path), onProgress);
        const { jobs, seen } = fromListingsJson(text, srcKey);
        if (jobs.length) return { jobs, seen, via: `${path} @ ${branch}` };
      } catch {
        /* next candidate */
      }
    }
  }

  throw new Error(
    "No job table found. Check that the repo is public and its README has a listings table."
  );
}

function stableId(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return "j" + (h >>> 0).toString(36);
}

function fmtDate(job) {
  if (job.posted) {
    return new Date(job.posted).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return job.postedLabel || "—";
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Icons — inline SVG so the dependency list stays at react + react-dom */
/* ------------------------------------------------------------------ */

const Ico = {
  grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  compass: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </svg>
  ),
  doc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  ),
  chart: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 20V10M12 20V4M19 20v-7" strokeLinecap="round" />
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" strokeLinecap="round" />
    </svg>
  ),
  pin: (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" />
      <path
        d="M8.8 9.2l2.2 2.2 4-4"
        stroke="#0D0F13"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  ),
};

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: Ico.grid },
  { id: "discover", label: "Discover", icon: Ico.compass },
  { id: "applications", label: "Applications", icon: Ico.doc },
  { id: "insights", label: "Insights", icon: Ico.chart },
  { id: "settings", label: "Settings", icon: Ico.gear },
];

const PAGE_META = {
  dashboard: ["Dashboard", "Track your job applications"],
  discover: ["Discover", "Roles pulled from GitHub listing repos"],
  applications: ["Applications", "Everything you're tracking"],
  insights: ["Insights", "How your pipeline is converting"],
  settings: ["Settings", "Sources and data"],
};

function Pill({ status }) {
  const s = STAGE_MAP[status];
  if (!s) return null;
  return (
    <span className="pill" style={{ color: s.color, background: `${s.color}22` }}>
      {s.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const [sources, setSources] = useState([]);
  const [tracked, setTracked] = useState({});
  const [jobs, setJobs] = useState([]);
  const [status, setStatus] = useState({});
  const [view, setView] = useState("dashboard");
  const [ready, setReady] = useState(false);

  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState("");
  const [maxAgeDays, setMaxAgeDays] = useState(0);
  const [region, setRegion] = useState("");
  const [stageFilter, setStageFilter] = useState(null);
  const [limit, setLimit] = useState(40);
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  /* ---------------------------- persistence ------------------------ */

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(KEY);
        if (res && res.value) {
          const d = JSON.parse(res.value);
          setSources(d.sources || []);
          setTracked(d.tracked || {});
        }
      } catch {
        /* first run */
      }
      setReady(true);
    })();
  }, []);

  const persist = useCallback(async (nextSources, nextTracked) => {
    try {
      await window.storage.set(
        KEY,
        JSON.stringify({ sources: nextSources, tracked: nextTracked })
      );
    } catch (e) {
      console.error("Could not save:", e);
    }
  }, []);

  /* ---------------------------- fetching --------------------------- */

  const refresh = useCallback(async (srcKey) => {
    setStatus((s) => ({ ...s, [srcKey]: { state: "loading", bytes: 0 } }));
    try {
      const { jobs: fetched, seen, via } = await loadSource(srcKey, (bytes) =>
        setStatus((s) =>
          s[srcKey]?.state === "loading"
            ? { ...s, [srcKey]: { state: "loading", bytes } }
            : s
        )
      );
      setJobs((prev) => [...prev.filter((j) => j.source !== srcKey), ...fetched]);
      setStatus((s) => ({
        ...s,
        [srcKey]: { state: "ok", count: fetched.length, seen, via },
      }));
    } catch (e) {
      setStatus((s) => ({ ...s, [srcKey]: { state: "error", msg: e.message } }));
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    sources.forEach((s) => {
      if (!status[s]) refresh(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sources]);

  function addSource() {
    const parsed = parseRepo(input);
    if (!parsed) {
      setStatus((s) => ({
        ...s,
        __input: { state: "error", msg: "That doesn't look like a GitHub repo link." },
      }));
      return;
    }
    if (sources.includes(parsed.key)) return setInput("");
    const next = [...sources, parsed.key];
    setSources(next);
    setInput("");
    setStatus((s) => ({ ...s, __input: undefined }));
    persist(next, tracked);
  }

  function removeSource(key) {
    const next = sources.filter((s) => s !== key);
    setSources(next);
    setJobs((j) => j.filter((x) => x.source !== key));
    setStatus((s) => {
      const c = { ...s };
      delete c[key];
      return c;
    });
    persist(next, tracked);
  }

  /* ---------------------------- tracking --------------------------- */

  function track(job, stage) {
    const prev = tracked[job.id];
    const next = {
      ...tracked,
      [job.id]: {
        status: stage,
        notes: prev?.notes || "",
        appliedOn:
          stage === "applied" && !prev?.appliedOn ? Date.now() : prev?.appliedOn || null,
        updatedAt: Date.now(),
        job: prev?.job || job,
      },
    };
    setTracked(next);
    persist(sources, next);
  }

  function untrack(id) {
    const next = { ...tracked };
    delete next[id];
    setTracked(next);
    persist(sources, next);
  }

  function setNotes(id, notes) {
    if (!tracked[id]) return;
    const next = { ...tracked, [id]: { ...tracked[id], notes } };
    setTracked(next);
    persist(sources, next);
  }

  function addManual() {
    const company = window.prompt("Company");
    if (!company) return;
    const title = window.prompt("Role");
    if (!title) return;
    const url = window.prompt("Link (optional)") || "";
    track(
      {
        id: stableId(url || `${company}|${title}|${Date.now()}`),
        company,
        title,
        location: "",
        url,
        open: true,
        posted: Date.now(),
        category: "",
        badges: {},
        source: "manual",
      },
      "saved"
    );
    setView("applications");
  }

  /* ---------------------------- derived ---------------------------- */

  const counts = useMemo(() => {
    const c = Object.fromEntries(STAGES.map((s) => [s.id, 0]));
    Object.values(tracked).forEach((t) => {
      if (c[t.status] !== undefined) c[t.status]++;
    });
    return c;
  }, [tracked]);

  const totalTracked = Object.keys(tracked).length;

  const categories = useMemo(() => {
    const set = new Set();
    jobs.forEach((j) => j.category && set.add(j.category));
    return [...set].sort();
  }, [jobs]);

  const discoverJobs = useMemo(() => {
    const q = debounced.toLowerCase().trim();
    let list = jobs;
    if (maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 86400000;
      list = list.filter((j) => !j.posted || j.posted >= cutoff);
    }
    if (region === "na") list = list.filter((j) => isNorthAmerica(j.location));
    if (region === "remote") list = list.filter((j) => isRemote(j.location));
    if (category) list = list.filter((j) => j.category === category);
    if (q) {
      list = list.filter(
        (j) =>
          j.company.toLowerCase().includes(q) ||
          j.title.toLowerCase().includes(q) ||
          (j.location || "").toLowerCase().includes(q)
      );
    }
    return [...list].sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        (b.posted || 0) - (a.posted || 0) ||
        (b.updated || 0) - (a.updated || 0)
    );
  }, [jobs, debounced, category, maxAgeDays, region]);

  const discoverGroups = useMemo(() => {
    const byCat = new Map();
    for (const j of discoverJobs) {
      const k = j.category || "Other";
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k).push(j);
    }
    const known = CATEGORY_ORDER.filter((c) => byCat.has(c));
    const extra = [...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
    return [...known, ...extra].map((c) => ({ category: c, jobs: byCat.get(c) }));
  }, [discoverJobs]);

  const trackedList = useMemo(() => {
    const q = debounced.toLowerCase().trim();
    let list = Object.entries(tracked).map(([id, t]) => ({ id, ...t }));
    if (stageFilter) list = list.filter((t) => t.status === stageFilter);
    if (q) {
      list = list.filter(
        (t) =>
          t.job.company.toLowerCase().includes(q) ||
          t.job.title.toLowerCase().includes(q)
      );
    }
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [tracked, stageFilter, debounced]);

  function exportCsv() {
    const rows = [
      ["Company", "Role", "Location", "Status", "Applied on", "Notes", "Link"],
      ...Object.values(tracked).map((t) => [
        t.job.company,
        t.job.title,
        t.job.location || "",
        STAGE_MAP[t.status]?.label || t.status,
        t.appliedOn ? new Date(t.appliedOn).toLocaleDateString() : "",
        (t.notes || "").replace(/\n/g, " "),
        t.job.url || "",
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "applications.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const [title, subtitle] = PAGE_META[view];

  /* ---------------------------- render ----------------------------- */

  return (
    <div className="app">
      <style>{CSS}</style>

      <aside className="side">
        <div className="brand">
          <span className="brand-mark">{Ico.pin}</span>
          <span className="brand-name">
            Apply<span>Trace</span>
          </span>
        </div>

        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? "nav-item on" : "nav-item"}
              onClick={() => setView(n.id)}
            >
              <span className="nav-ico">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="head">
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <button className="btn primary" onClick={addManual}>
            <span className="btn-ico">{Ico.plus}</span> Add Application
          </button>
        </header>

        {view === "dashboard" && (
          <>
            <div className="stats">
              <Stat
                label="Total Applications"
                value={totalTracked}
                icon={Ico.doc}
                tone="#5B5BD6"
              />
              <Stat
                label="Interviews"
                value={counts.interviewing}
                icon={Ico.users}
                tone="#30A46C"
              />
              <Stat
                label="Offers"
                value={counts.offer}
                icon={Ico.check}
                tone="#E5484D"
              />
            </div>

            <section className="card">
              <div className="card-head">
                <h2>Recent Applications</h2>
                <button className="link" onClick={() => setView("applications")}>
                  View All →
                </button>
              </div>
              {trackedList.length === 0 ? (
                <Empty
                  title="Nothing tracked yet"
                  body="Add a source under Settings, then track roles from Discover."
                />
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th className="right">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trackedList.slice(0, 5).map((t) => (
                      <tr key={t.id}>
                        <td className="strong">{t.job.company}</td>
                        <td>{t.job.title}</td>
                        <td>
                          <Pill status={t.status} />
                        </td>
                        <td className="right dim">
                          {new Date(t.updatedAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}

        {view === "discover" && (
          <>
            <div className="filters">
              <input
                className="field grow"
                placeholder="Search company, role, or location"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="field"
                value={maxAgeDays}
                onChange={(e) => setMaxAgeDays(Number(e.target.value))}
              >
                <option value={0}>Any age</option>
                <option value={7}>This week</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
              <select
                className="field"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="">Anywhere</option>
                <option value="na">US &amp; Canada</option>
                <option value="remote">Remote</option>
              </select>
              {categories.length > 0 && (
                <select
                  className="field"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {discoverJobs.length === 0 ? (
              <Empty
                title={sources.length ? "Nothing matches" : "No sources yet"}
                body={
                  sources.length
                    ? "Try a broader search or clear the filters."
                    : "Add a GitHub listing repo under Settings."
                }
              />
            ) : (
              discoverGroups.map((g) => (
                <section key={g.category} className="card">
                  <div className="card-head">
                    <h2>{g.category}</h2>
                    <span className="count">{g.jobs.length}</span>
                  </div>
                  <div className="rows">
                    {g.jobs.slice(0, limit).map((job) => (
                      <Row
                        key={job.id}
                        job={job}
                        entry={tracked[job.id]}
                        onTrack={track}
                        onUntrack={untrack}
                      />
                    ))}
                  </div>
                  {g.jobs.length > limit && (
                    <button className="more" onClick={() => setLimit((l) => l + 40)}>
                      Show more · {g.jobs.length - limit} remaining
                    </button>
                  )}
                </section>
              ))
            )}
          </>
        )}

        {view === "applications" && (
          <>
            <div className="filters">
              <input
                className="field grow"
                placeholder="Search your applications"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="field"
                value={stageFilter || ""}
                onChange={(e) => setStageFilter(e.target.value || null)}
              >
                <option value="">All statuses</option>
                {STAGES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={exportCsv} disabled={!totalTracked}>
                Export CSV
              </button>
            </div>

            {trackedList.length === 0 ? (
              <Empty
                title="No applications yet"
                body="Track roles from Discover, or use Add Application."
              />
            ) : (
              <section className="card">
                <div className="rows">
                  {trackedList.map((t) => (
                    <Row
                      key={t.id}
                      job={t.job}
                      entry={t}
                      expanded={expanded === t.id}
                      onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
                      onTrack={track}
                      onUntrack={untrack}
                      onNotes={setNotes}
                      showNotes
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {view === "insights" && (
          <section className="card">
            <div className="card-head">
              <h2>Pipeline</h2>
            </div>
            {totalTracked === 0 ? (
              <Empty title="No data yet" body="Track a few roles to see conversion." />
            ) : (
              <>
                <div className="bar">
                  {STAGES.map((s) =>
                    counts[s.id] ? (
                      <span
                        key={s.id}
                        title={`${counts[s.id]} ${s.label}`}
                        style={{ flexGrow: counts[s.id], background: s.color }}
                      />
                    ) : null
                  )}
                </div>
                <div className="legend">
                  {STAGES.map((s) => (
                    <div key={s.id} className="leg">
                      <i style={{ background: s.color }} />
                      <b>{counts[s.id]}</b> {s.label}
                    </div>
                  ))}
                </div>
                <div className="rates">
                  <Rate
                    label="Response rate"
                    value={counts.applied ? (counts.interviewing + counts.offer) / counts.applied : 0}
                    hint="interviews + offers ÷ applied"
                  />
                  <Rate
                    label="Offer rate"
                    value={counts.interviewing ? counts.offer / counts.interviewing : 0}
                    hint="offers ÷ interviews"
                  />
                  <Rate
                    label="Rejection rate"
                    value={totalTracked ? counts.rejected / totalTracked : 0}
                    hint="rejected ÷ everything tracked"
                  />
                </div>
              </>
            )}
          </section>
        )}

        {view === "settings" && (
          <>
            <section className="card">
              <div className="card-head">
                <h2>Sources</h2>
              </div>
              <div className="filters">
                <input
                  className="field grow"
                  placeholder="github.com/SimplifyJobs/New-Grad-Positions"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addSource()}
                />
                <button className="btn primary" onClick={addSource}>
                  Add source
                </button>
              </div>
              {status.__input?.state === "error" && (
                <p className="err">{status.__input.msg}</p>
              )}
              {sources.length > 0 && (
                <div className="rows">
                  {sources.map((s) => {
                    const st = status[s] || {};
                    return (
                      <div key={s} className="row">
                        <div className="row-text">
                          <div className="row-title mono">{s}</div>
                          <div className={`row-meta ${st.state || ""}`}>
                            {st.state === "loading" &&
                              (st.bytes
                                ? `loading… ${(st.bytes / 1048576).toFixed(1)} MB`
                                : "loading…")}
                            {st.state === "ok" && `${st.count.toLocaleString()} roles`}
                            {st.state === "error" && st.msg}
                          </div>
                        </div>
                        <div className="row-actions">
                          <button className="btn small" onClick={() => refresh(s)}>
                            Refresh
                          </button>
                          <button className="btn small" onClick={() => removeSource(s)}>
                            Remove
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Data</h2>
              </div>
              <div className="filters">
                <button className="btn" onClick={exportCsv} disabled={!totalTracked}>
                  Export CSV
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    if (window.confirm("Delete all tracked applications?")) {
                      setTracked({});
                      persist(sources, {});
                    }
                  }}
                >
                  Clear all applications
                </button>
              </div>
              <p className="note">
                Everything lives in this browser's storage. Export before clearing
                browser data.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Pieces                                                             */
/* ------------------------------------------------------------------ */

function Stat({ label, value, icon, tone }) {
  return (
    <div className="stat">
      <span className="stat-ico" style={{ background: `${tone}22`, color: tone }}>
        {icon}
      </span>
      <div>
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
      </div>
    </div>
  );
}

function Rate({ label, value, hint }) {
  return (
    <div className="rate">
      <div className="rate-label">{label}</div>
      <div className="rate-value">{Math.round(value * 100)}%</div>
      <div className="rate-hint">{hint}</div>
    </div>
  );
}

function Empty({ title, body }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function Row({ job, entry, onTrack, onUntrack, onNotes, showNotes, expanded, onToggle }) {
  const stage = entry ? STAGE_MAP[entry.status] : null;
  return (
    <article className="row-wrap">
      <div
        className="row"
        style={stage ? { borderLeft: `2px solid ${stage.color}` } : undefined}
      >
        <div className="row-text">
          <div className="row-title">{job.company}</div>
          <div className="row-sub">{job.title}</div>
          <div className="row-meta">
            {job.location && <span>{job.location}</span>}
            <span className="mono">{job.ageLabel || fmtDate(job)}</span>
            {job.badges?.faang && <span className="tag hot">FAANG+</span>}
            {job.badges?.advDegree && <span className="tag">Advanced degree</span>}
            {job.badges?.noSponsor && <span className="tag warn">No sponsorship</span>}
            {job.badges?.citizen && <span className="tag warn">US citizenship</span>}
          </div>
        </div>
        <div className="row-actions">
          {job.url && (
            <a
              className="btn primary small"
              href={job.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              Apply
            </a>
          )}
          <select
            className="field small"
            value={entry ? entry.status : ""}
            onChange={(e) =>
              e.target.value ? onTrack(job, e.target.value) : onUntrack(job.id)
            }
          >
            <option value="">Not tracked</option>
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          {showNotes && (
            <button className="btn small" onClick={onToggle}>
              {entry?.notes ? "Notes ●" : "Notes"}
            </button>
          )}
        </div>
      </div>
      {showNotes && expanded && (
        <div className="notes">
          <textarea
            className="field area"
            placeholder="Recruiter name, interview dates, take-home details…"
            value={entry?.notes || ""}
            onChange={(e) => onNotes(job.id, e.target.value)}
          />
          {entry?.appliedOn && (
            <p className="note mono">
              Applied {new Date(entry.appliedOn).toLocaleDateString()}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap');

.app{
  --sidebar:#0D0F13; --bg:#15171C; --card:#1C1F26; --card2:#22262E;
  --line:#282C35; --text:#FFFFFF; --muted:#8B919E; --dim:#646B78;
  --accent:#E5484D; --accent-hi:#F0595E;
  display:flex; min-height:100vh; background:var(--bg); color:var(--text);
  font-family:Poppins,ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
  font-size:14px; line-height:1.5;
}
.app *{box-sizing:border-box}
.app button:focus-visible,.app a:focus-visible,.app input:focus-visible,
.app select:focus-visible,.app textarea:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace}

/* sidebar */
.side{width:264px;flex-shrink:0;background:var(--sidebar);
  display:flex;flex-direction:column;padding:26px 18px;gap:30px}
.brand{display:flex;align-items:center;gap:11px;padding:0 8px}
.brand-mark{width:30px;height:30px;color:var(--accent);display:block}
.brand-mark svg{width:100%;height:100%}
.brand-name{font-size:19px;font-weight:700;letter-spacing:-.02em}
.brand-name span{color:var(--accent)}
.nav{display:flex;flex-direction:column;gap:4px}
.nav-item{display:flex;align-items:center;gap:13px;padding:11px 14px;border:0;
  border-radius:10px;background:transparent;color:var(--muted);font:inherit;
  font-weight:500;cursor:pointer;text-align:left;transition:background .15s,color .15s}
.nav-item:hover{background:#ffffff0a;color:var(--text)}
.nav-item.on{background:#E5484D1F;color:var(--accent);font-weight:600}
.nav-ico{width:19px;height:19px;flex-shrink:0}
.nav-ico svg{width:100%;height:100%}

/* main */
.main{flex:1;min-width:0;padding:30px 34px 70px;display:flex;
  flex-direction:column;gap:22px}
.head{display:flex;justify-content:space-between;align-items:flex-start;
  gap:18px;flex-wrap:wrap}
.head h1{margin:0;font-size:31px;font-weight:700;letter-spacing:-.025em}
.head p{margin:5px 0 0;color:var(--muted);font-size:14px}

.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 17px;
  border:1px solid var(--line);border-radius:10px;background:var(--card);
  color:var(--text);font:inherit;font-weight:600;font-size:13px;
  cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--card2)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{background:var(--accent-hi)}
.btn.danger{color:var(--accent);border-color:#E5484D55}
.btn.small{padding:7px 12px;font-size:12px;border-radius:8px}
.btn:disabled{opacity:.4;cursor:default}
.btn-ico{width:16px;height:16px}
.btn-ico svg{width:100%;height:100%}
.link{border:0;background:none;color:var(--accent);font:inherit;
  font-weight:600;font-size:13px;cursor:pointer}

/* stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:15px;
  padding:22px;display:flex;align-items:center;gap:17px}
.stat-ico{width:52px;height:52px;border-radius:13px;display:grid;
  place-items:center;flex-shrink:0}
.stat-ico svg{width:24px;height:24px}
.stat-label{color:var(--muted);font-size:13px;font-weight:500}
.stat-value{font-size:31px;font-weight:700;line-height:1.15;letter-spacing:-.02em}

/* card */
.card{background:var(--card);border:1px solid var(--line);border-radius:15px;
  padding:22px 24px}
.card-head{display:flex;justify-content:space-between;align-items:center;
  gap:12px;margin-bottom:16px}
.card-head h2{margin:0;font-size:17px;font-weight:600;letter-spacing:-.01em}
.count{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--muted);
  background:var(--card2);border-radius:20px;padding:2px 10px}

/* table */
.tbl{width:100%;border-collapse:collapse}
.tbl th{text-align:left;font-size:11px;font-weight:600;letter-spacing:.08em;
  text-transform:uppercase;color:var(--dim);padding:0 10px 13px;
  border-bottom:1px solid var(--line)}
.tbl td{padding:15px 10px;border-bottom:1px solid var(--line);font-size:14px}
.tbl tr:last-child td{border-bottom:0}
.tbl .strong{font-weight:600}
.tbl .right{text-align:right}
.tbl .dim{color:var(--muted);font-size:13px}
.pill{display:inline-block;padding:4px 12px;border-radius:20px;
  font-size:12px;font-weight:600}

/* filters */
.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.field{padding:11px 13px;border:1px solid var(--line);border-radius:10px;
  background:var(--card);color:var(--text);font:inherit;font-size:13px}
.field.grow{flex:1;min-width:210px}
.field.small{padding:7px 10px;font-size:12px;border-radius:8px}
.field::placeholder{color:var(--dim)}
.field.area{width:100%;min-height:92px;resize:vertical;margin-top:12px;
  background:var(--bg);line-height:1.55}

/* rows */
.rows{display:flex;flex-direction:column}
.row-wrap{border-bottom:1px solid var(--line)}
.row-wrap:last-child{border-bottom:0}
.row{display:flex;justify-content:space-between;align-items:center;gap:16px;
  padding:14px 0 14px 0;flex-wrap:wrap}
.row-text{min-width:190px;flex:1;padding-left:12px}
.row-title{font-weight:600}
.row-sub{color:var(--muted);font-size:13px;margin-top:1px}
.row-meta{display:flex;flex-wrap:wrap;gap:9px;align-items:center;
  margin-top:6px;font-size:12px;color:var(--dim)}
.row-meta.ok{color:#30A46C}
.row-meta.error{color:var(--accent)}
.row-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tag{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  border:1px solid var(--line);border-radius:4px;padding:1px 6px;color:var(--muted)}
.tag.hot{border-color:#F5A52455;color:#F5A524}
.tag.warn{border-color:#E5484D55;color:var(--accent)}
.notes{padding:0 12px 16px}
.note{margin:9px 0 0;font-size:12px;color:var(--dim)}
.err{color:var(--accent);font-size:12px;margin:10px 0 0}
.more{width:100%;margin-top:14px;padding:12px;border:1px dashed var(--line);
  border-radius:10px;background:none;color:var(--muted);font:inherit;
  font-size:13px;cursor:pointer}
.more:hover{border-color:var(--dim);color:var(--text)}

/* insights */
.bar{display:flex;gap:3px;height:15px;border-radius:5px;overflow:hidden}
.bar span{min-width:5px}
.legend{display:flex;flex-wrap:wrap;gap:17px;margin-top:15px}
.leg{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--muted)}
.leg i{width:9px;height:9px;border-radius:3px}
.leg b{color:var(--text);font-family:ui-monospace,Menlo,monospace}
.rates{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
  gap:16px;margin-top:26px}
.rate{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:18px}
.rate-label{color:var(--muted);font-size:13px;font-weight:500}
.rate-value{font-size:27px;font-weight:700;margin-top:3px;letter-spacing:-.02em}
.rate-hint{color:var(--dim);font-size:11px;margin-top:3px}

.empty{padding:42px 20px;display:flex;flex-direction:column;gap:6px;
  text-align:center}
.empty strong{font-size:15px;font-weight:600}
.empty span{color:var(--muted);font-size:13px}

@media (max-width:860px){
  .app{flex-direction:column}
  .side{width:100%;flex-direction:row;align-items:center;gap:16px;
    padding:14px 16px;overflow-x:auto}
  .side .nav{flex-direction:row}
  .main{padding:22px 16px 60px}
}
`;
