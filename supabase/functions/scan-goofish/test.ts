// Test cho scan-goofish — chạy: deno test --allow-env --no-config supabase/functions/scan-goofish/test.ts
// Không gọi mạng thật: fetch được giả lập cho Supabase (Auth / PostgREST / Storage) và Gemini.

// Assert tối giản (không phụ thuộc jsr:@std/assert).
function assert(cond: unknown, msg = "assert thất bại"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? msg + ": " : ""}khác nhau\n  actual:   ${a}\n  expected: ${e}`);
}

Deno.env.set("SCAN_GOOFISH_TEST", "1"); // không chạy Deno.serve khi import
const m = await import("./index.ts");

const UID = "a0478118-6be3-4fe8-b2bd-b6b49011ca84";
const KU = "11111111-1111-4111-8111-111111111111";
const ZP6 = "22222222-2222-4222-8222-222222222222";

const catalog = m.buildCatalog([
  { id: KU, name: "K Ultra", brand: "1Zpresso", code_prefix: "KU", aliases: ["KU", "K-Ultra"] },
  { id: ZP6, name: "ZP6 Special", brand: "1Zpresso", code_prefix: "ZP6", aliases: ["ZP6"] },
]);

function aiOut(over: Record<string, unknown> = {}) {
  return {
    is_goofish_listing: true,
    listing_title: { value: "  1Zpresso K-Ultra 手摇磨豆机 全新 ", confidence: 0.95 },
    price_cny: { value: 1010, confidence: 0.93 },
    seller_nickname: { value: "咖啡小王", confidence: 0.9 },
    seller_region: { value: "浙江", confidence: 0.6 },
    model_id: { value: "M1", confidence: 0.92, matched_text: "K-Ultra" },
    qty_guess: { value: null, confidence: 0.2 },
    condition_text: "全新未拆",
    notes: "Có giá gạch ngang ¥1.299 — đã lấy giá hiện tại.",
    ...over,
  };
}

// ---------------------------------------------------------------- tiện ích thuần

Deno.test("cleanAiOutput: map mã → uuid, trim, ngưỡng tin cậy ⇒ null + flag", () => {
  const r = m.cleanAiOutput(aiOut(), catalog, 0.7);
  assertEquals(r.fields.listing_title.value, "1Zpresso K-Ultra 手摇磨豆机 全新");
  assertEquals(r.fields.price_cny.value, 1010);
  assertEquals(r.fields.model_id.value, KU);
  assertEquals(r.fields.model_id.matched_text, "K-Ultra");
  assertEquals(r.fields.seller_region.value, null); // 0.6 < 0.7
  assertEquals(r.fields.seller_region.confidence, 0.6);
  assertEquals(r.flags, ["seller_region"]);
  assertEquals(r.qty_guess, null);
  assertEquals(r.condition_text, "全新未拆");
  assertEquals(Object.keys(r.fields), ["listing_title", "price_cny", "seller_nickname", "seller_region", "model_id"]);
});

Deno.test("cleanAiOutput: bỏ qua variant_id kiểu cũ nếu AI vẫn trả về", () => {
  const r = m.cleanAiOutput(aiOut({ variant_id: { value: "V1", confidence: 0.99 } }), catalog, 0.7);
  assert(!("variant_id" in r.fields), "không được có fields.variant_id");
  assert(!(r.flags as string[]).includes("variant_id"));
  assertEquals(r.fields.model_id.value, KU);
});

Deno.test("cleanAiOutput: qty_guess — chỉ nhận số nguyên 2..MAX_QTY đủ tin cậy, không gắn flag", () => {
  const q = (qty: unknown) => m.cleanAiOutput(aiOut({ qty_guess: qty }), catalog, 0.7).qty_guess;
  assertEquals(q({ value: 2, confidence: 0.9 }), { value: 2, confidence: 0.9 });
  assertEquals(q({ value: "3", confidence: 0.8 }), { value: 3, confidence: 0.8 });
  assertEquals(q({ value: 1, confidence: 0.95 }), null); // 1 chiếc = mặc định
  assertEquals(q({ value: 2.5, confidence: 0.95 }), null);
  assertEquals(q({ value: m.MAX_QTY + 1, confidence: 0.95 }), null);
  assertEquals(q({ value: 2, confidence: 0.5 }), null); // dưới ngưỡng
  assertEquals(q({ value: null, confidence: 0 }), null);
  assertEquals(q(undefined), null); // thiếu trường ⇒ không hỏng kết quả
  const r = m.cleanAiOutput(aiOut({ qty_guess: "两台" }), catalog, 0.7);
  assertEquals(r.qty_guess, null);
  assertEquals(r.flags, ["seller_region"]);
});

Deno.test("cleanAiOutput: giá sai / mã ngoài danh mục / confidence ngoài [0,1]", () => {
  const r = m.cleanAiOutput(
    aiOut({
      price_cny: { value: 0, confidence: 0.99 },
      model_id: { value: "M9", confidence: 1.7, matched_text: null },
      seller_region: { value: "上海", confidence: -2 },
    }),
    catalog,
    0.7,
  );
  assertEquals(r.fields.price_cny.value, null);
  assertEquals(r.fields.model_id.value, null);
  assertEquals(r.fields.seller_region.confidence, 0);
  assert(r.flags.includes("price_cny"));
  assert(r.flags.includes("model_id"));
  assert(r.flags.includes("seller_region"));
});

Deno.test("cleanAiOutput: không phải tin Goofish ⇒ AI_UNREADABLE", () => {
  let code = "";
  try {
    m.cleanAiOutput(aiOut({ is_goofish_listing: false }), catalog, 0.7);
  } catch (e) {
    code = (e as InstanceType<typeof m.ScanError>).code;
  }
  assertEquals(code, "AI_UNREADABLE");
});

Deno.test("cleanPrice", () => {
  assertEquals(m.cleanPrice(1010), 1010);
  assertEquals(m.cleanPrice("¥1,010.50"), 1010.5);
  assertEquals(m.cleanPrice(null), null);
  assertEquals(m.cleanPrice(1010.123), undefined);
  assertEquals(m.cleanPrice(100_001), undefined);
  assertEquals(m.cleanPrice("liên hệ"), undefined);
});

Deno.test("parseRequest: path phải thuộc {uid}/, text chuẩn hoá + giới hạn", () => {
  const ok = m.parseRequest({ input: { kind: "image", image_path: `${UID}/goofish/a.jpg` }, goofish_url: null }, UID);
  assertEquals(ok.input.kind, "image");
  for (const p of ["other/goofish/a.jpg", `${UID}/../x/a.jpg`, `${UID}//a.jpg`]) {
    let code = "";
    try {
      m.parseRequest({ input: { kind: "image", image_path: p } }, UID);
    } catch (e) {
      code = (e as InstanceType<typeof m.ScanError>).code;
    }
    assertEquals(code, "INVALID_INPUT", p);
  }
  const t = m.parseRequest({ input: { kind: "text", text: "  价格  ¥1010 \n\n\n\n 浙江 " } }, UID);
  assertEquals(t.input.kind === "text" && t.input.text, "价格 ¥1010\n\n浙江");
  let code = "";
  try {
    m.parseRequest({ input: { kind: "text", text: "x".repeat(20_001) } }, UID);
  } catch (e) {
    code = (e as InstanceType<typeof m.ScanError>).code;
  }
  assertEquals(code, "INVALID_INPUT");
});

Deno.test("parseItemId / monthStartVnIso / detectImageMime", () => {
  assertEquals(m.parseItemId("https://www.goofish.com/item?id=1027765536701&spm=x"), "1027765536701");
  assertEquals(m.parseItemId("https://www.goofish.com/"), null);
  // 2026-10-31 18:00 UTC = 01/11 01:00 giờ VN ⇒ đầu tháng 11 giờ VN = 2026-10-31T17:00Z
  assertEquals(m.monthStartVnIso(new Date("2026-10-31T18:00:00Z")), "2026-10-31T17:00:00.000Z");
  assertEquals(m.detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assertEquals(m.detectImageMime(new Uint8Array([1, 2, 3])), null);
});

Deno.test("buildResponseSchema: enum model = mã danh mục + NONE; không còn variant_id; có qty_guess", () => {
  const s = m.buildResponseSchema(catalog) as {
    properties: Record<string, { properties: { value: { enum?: string[]; type: string } } }>;
    required: string[];
  };
  assertEquals(s.properties.model_id.properties.value.enum, ["M1", "M2", "NONE"]);
  assert(!("variant_id" in s.properties));
  assert(!s.required.includes("variant_id"));
  assertEquals(s.properties.qty_guess.properties.value.type, "INTEGER");
  assert(s.required.includes("qty_guess"));
});

Deno.test("catalogText: tên + hãng + tiền tố mã + tên gọi khác; danh mục rỗng ⇒ NONE", () => {
  const t = m.catalogText(catalog);
  assert(t.includes('M1 = model "K Ultra" by 1Zpresso [shop code: KU] (also called: KU, K-Ultra)'), t);
  assert(t.includes('M2 = model "ZP6 Special" by 1Zpresso [shop code: ZP6] (also called: ZP6)'), t);
  assert(!/variant/i.test(t));
  assert(m.catalogText(m.buildCatalog([])).includes("always answer NONE for model_id"));
  // dòng PostgREST thiếu cột ⇒ giá trị an toàn
  assertEquals(m.toCatalogModel({ id: KU, name: "K Ultra", aliases: null }), {
    id: KU,
    name: "K Ultra",
    brand: null,
    code_prefix: null,
    aliases: [],
  });
});

// ---------------------------------------------------------------- handler (fetch giả lập)

const SB = "https://kho-coi.supabase.co";
type Call = { url: string; method: string; body: unknown; headers: Headers };

function geminiOk(json: unknown) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 150, thoughtsTokenCount: 50 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeEnv(over: Record<string, string> = {}) {
  const env: Record<string, string> = {
    SUPABASE_URL: SB,
    SUPABASE_ANON_KEY: "anon-test",
    GEMINI_API_KEY: "test-key-not-real",
    ALLOWED_USER_IDS: UID,
    SCAN_MODEL: "gemini-test-primary",
    ...over,
  };
  return (k: string) => env[k];
}

function makeFetch(opts: {
  uid?: string;
  gemini?: (model: string) => Response;
  reserve?: () => Response;
  jpeg?: boolean;
}) {
  const calls: Call[] = [];
  const jsonRes = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = req.url;
    const text = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    calls.push({ url, method: req.method, body: text ? JSON.parse(text) : null, headers: req.headers });
    const path = new URL(url).pathname;
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      const model = decodeURIComponent(path.split("/models/")[1].split(":")[0]);
      return opts.gemini ? opts.gemini(model) : geminiOk(aiOut());
    }
    if (path === "/auth/v1/user") {
      return jsonRes({ id: opts.uid ?? UID, aud: "authenticated", role: "authenticated", email: "owner@example.com" });
    }
    if (path === "/rest/v1/rpc/ai_scan_reserve") return opts.reserve ? opts.reserve() : jsonRes("scan-0001");
    if (path === "/rest/v1/rpc/ai_scan_finish") return new Response(null, { status: 204 });
    if (path === "/rest/v1/models") {
      return jsonRes([
        { id: KU, name: "K Ultra", brand: "1Zpresso", code_prefix: "KU", aliases: ["KU"] },
        { id: ZP6, name: "ZP6 Special", brand: "1Zpresso", code_prefix: "ZP6", aliases: [] },
      ]);
    }
    if (path === "/rest/v1/settings") {
      const row = { ai_confidence_threshold: 0.7, ai_scan_monthly_cap: 100 };
      return jsonRes((req.headers.get("accept") ?? "").includes("pgrst.object") ? row : [row]);
    }
    if (path === "/rest/v1/sellers") {
      return jsonRes([{ id: "seller-1", nickname: "咖啡小王", is_avoided: true, is_hidden: false }]);
    }
    if (path === "/rest/v1/lots") return jsonRes([{ id: "lot-dup-1" }]);
    if (path === "/rest/v1/ai_scan_log") {
      return new Response(null, { status: 200, headers: { "content-range": "*/12" } });
    }
    if (path.startsWith("/storage/v1/object/private-images/")) {
      const bytes = opts.jpeg === false ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
      return new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return jsonRes({ message: `unmocked ${path}` }, 404);
  };
  return { fetch: f as typeof fetch, calls };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${SB}/functions/v1/scan-goofish`, {
    method: "POST",
    headers: {
      Authorization: "Bearer user-jwt",
      "content-type": "application/json",
      Origin: "https://hoangphong2104.github.io",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const textBody = {
  input: { kind: "text", text: "1Zpresso K-Ultra 全新 ¥1010 原价¥1299 卖家：咖啡小王 IP属地：浙江" },
  goofish_url: "https://www.goofish.com/item?id=1027765536701",
};
const silent = () => {};

Deno.test("handler: thành công (text) — đúng hợp đồng §5.2 + ai_scan_finish ok", async () => {
  const { fetch, calls } = makeFetch({});
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const res = await h(post(textBody));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "https://hoangphong2104.github.io");
  const b = await res.json();
  assertEquals(b.ok, true);
  assertEquals(b.scan_id, "scan-0001");
  assertEquals(b.model, "gemini-test-primary");
  assertEquals(b.fields.model_id, { value: KU, confidence: 0.92, matched_text: "K-Ultra" });
  assert(!("variant_id" in b.fields), "response không còn fields.variant_id");
  assertEquals(b.flags, ["seller_region"]);
  assertEquals(b.qty_guess, null);
  assertEquals(b.seller_match, { seller_id: "seller-1", nickname: "咖啡小王", is_avoided: true });
  assertEquals(b.duplicate_lot_ids, ["lot-dup-1"]);
  assertEquals(b.usage, { scans_this_month: 12, cap: 100 });

  const gem = calls.find((c) => c.url.includes("generativelanguage"))!;
  assertEquals(gem.headers.get("x-goog-api-key"), "test-key-not-real");
  const g = gem.body as { contents: { parts: { text?: string }[] }[]; generationConfig: Record<string, unknown> };
  assertEquals(g.generationConfig.responseMimeType, "application/json");
  assert(g.contents[0].parts[1].text!.startsWith("<listing_text>"));
  // NFR-11: không đọc bảng khách / đơn / chiếc; schema v2: không còn bảng variants
  assert(!calls.some((c) => /\/rest\/v1\/(customers|orders|order_lines|payments|units|variants)/.test(c.url)));
  // danh mục: chỉ model đang bán, đúng cột v2
  const mq = new URL(calls.find((c) => new URL(c.url).pathname === "/rest/v1/models")!.url).searchParams;
  assertEquals(mq.get("select"), "id,name,brand,code_prefix,aliases");
  assertEquals(mq.get("is_active"), "eq.true");
  const catPart = g.contents[0].parts[0].text!;
  assert(catPart.includes('M1 = model "K Ultra" by 1Zpresso [shop code: KU]'), catPart);
  // lô trùng: theo goofish_item_id, bỏ lô đã huỷ
  const lq = new URL(calls.find((c) => new URL(c.url).pathname === "/rest/v1/lots")!.url).searchParams;
  assertEquals(lq.get("goofish_item_id"), "eq.1027765536701");
  assertEquals(lq.get("status"), "neq.cancelled");
  const fin = calls.find((c) => c.url.endsWith("/rpc/ai_scan_finish"))!;
  assertEquals(fin.body, {
    p_scan_id: "scan-0001",
    p_status: "ok",
    p_model: "gemini-test-primary",
    p_input_tokens: 1200,
    p_output_tokens: 200,
    p_cost_usd: 0,
    p_error_code: null,
  });
});

Deno.test('handler: tin ghi "两台" ⇒ trả qty_guess', async () => {
  const { fetch } = makeFetch({ gemini: () => geminiOk(aiOut({ qty_guess: { value: 2, confidence: 0.9 } })) });
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const b = await (await h(post(textBody))).json();
  assertEquals(b.ok, true);
  assertEquals(b.qty_guess, { value: 2, confidence: 0.9 });
  assert(!b.flags.includes("qty_guess"));
});

Deno.test("handler: ảnh — tải từ Storage, gửi inlineData base64", async () => {
  const { fetch, calls } = makeFetch({});
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const res = await h(post({ input: { kind: "image", image_path: `${UID}/goofish/x.jpg` } }));
  assertEquals(res.status, 200);
  const gem = calls.find((c) => c.url.includes("generativelanguage"))!;
  const part = (gem.body as { contents: { parts: Record<string, { mimeType: string }>[] }[] }).contents[0].parts[1];
  assertEquals(part.inlineData.mimeType, "image/jpeg");
  // không có goofish_url ⇒ không tra lô trùng
  assert(!calls.some((c) => c.url.includes("/rest/v1/lots")));
});

Deno.test("handler: Gemini 429 ⇒ thử fallback 1 lần ⇒ AI_QUOTA_EXHAUSTED, finish error 0 token", async () => {
  const seen: string[] = [];
  const { fetch, calls } = makeFetch({
    gemini: (model) => {
      seen.push(model);
      return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
    },
  });
  const h = m.createHandler({ env: makeEnv({ SCAN_MODEL_FALLBACK: "gemini-test-fallback" }), fetch, log: silent });
  const res = await h(post(textBody));
  assertEquals(res.status, 429);
  const b = await res.json();
  assertEquals(b.ok, false);
  assertEquals(b.error.code, "AI_QUOTA_EXHAUSTED");
  assertEquals(seen, ["gemini-test-primary", "gemini-test-fallback"]);
  const fin = calls.find((c) => c.url.endsWith("/rpc/ai_scan_finish"))!.body as Record<string, unknown>;
  assertEquals(fin.p_status, "error");
  assertEquals(fin.p_error_code, "AI_QUOTA_EXHAUSTED");
  assertEquals(fin.p_input_tokens, 0); // ⇒ ai_scan_reserve không tính lượt này
});

Deno.test("handler: fallback thành công sau 429", async () => {
  const { fetch } = makeFetch({
    gemini: (model) => model === "gemini-test-primary" ? new Response("{}", { status: 429 }) : geminiOk(aiOut()),
  });
  const h = m.createHandler({ env: makeEnv({ SCAN_MODEL_FALLBACK: "gemini-test-fallback" }), fetch, log: silent });
  const b = await (await h(post(textBody))).json();
  assertEquals(b.ok, true);
  assertEquals(b.model, "gemini-test-fallback");
});

Deno.test("handler: finishReason ≠ STOP ⇒ 422 AI_UNREADABLE (token vẫn ghi)", async () => {
  const { fetch, calls } = makeFetch({
    gemini: () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{" }] }, finishReason: "MAX_TOKENS" }],
          usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 4096 },
        }),
        { status: 200 },
      ),
  });
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const res = await h(post(textBody));
  assertEquals(res.status, 422);
  assertEquals((await res.json()).error.code, "AI_UNREADABLE");
  const fin = calls.find((c) => c.url.endsWith("/rpc/ai_scan_finish"))!.body as Record<string, unknown>;
  assertEquals(fin.p_input_tokens, 900);
});

Deno.test("handler: Gemini 500 ⇒ 502 AI_UPSTREAM_ERROR", async () => {
  const { fetch } = makeFetch({ gemini: () => new Response("oops", { status: 503 }) });
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const res = await h(post(textBody));
  assertEquals(res.status, 502);
  const b = await res.json();
  assertEquals(b.error.code, "AI_UPSTREAM_ERROR");
  assertEquals(b.error.upstream_status, undefined); // không lộ ra client
});

Deno.test("handler: SCAN_CAP_REACHED từ ai_scan_reserve ⇒ 429 kèm used/cap, không gọi Gemini", async () => {
  const { fetch, calls } = makeFetch({
    reserve: () =>
      new Response(
        JSON.stringify({
          code: "P0001",
          message: "SCAN_CAP_REACHED",
          details: '{"used": 100, "cap": 100}',
          hint: null,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  });
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const res = await h(post(textBody));
  assertEquals(res.status, 429);
  const b = await res.json();
  assertEquals(b.error.code, "SCAN_CAP_REACHED");
  assertEquals(b.error.used, 100);
  assertEquals(b.error.cap, 100);
  assert(!calls.some((c) => c.url.includes("generativelanguage")));
});

Deno.test("handler: user ngoài allowlist ⇒ 403 FORBIDDEN; thiếu JWT ⇒ 401", async () => {
  const { fetch, calls } = makeFetch({ uid: "99999999-9999-4999-8999-999999999999" });
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const res = await h(post(textBody));
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, "FORBIDDEN");
  assert(!calls.some((c) => c.url.includes("ai_scan_reserve")));

  const res2 = await h(post(textBody, { Authorization: "" }));
  assertEquals(res2.status, 401);
  assertEquals((await res2.json()).error.code, "NOT_AUTHENTICATED");
});

Deno.test("handler: image_path của người khác ⇒ 400 trước khi giữ lượt", async () => {
  const { fetch, calls } = makeFetch({});
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const res = await h(post({ input: { kind: "image", image_path: "someone-else/goofish/x.jpg" } }));
  assertEquals(res.status, 400);
  assert(!calls.some((c) => c.url.includes("ai_scan_reserve")));
});

Deno.test("handler: file không phải ảnh ⇒ 400, finish error 0 token", async () => {
  const { fetch, calls } = makeFetch({ jpeg: false });
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const res = await h(post({ input: { kind: "image", image_path: `${UID}/goofish/x.jpg` } }));
  assertEquals(res.status, 400);
  const fin = calls.find((c) => c.url.endsWith("/rpc/ai_scan_finish"))!.body as Record<string, unknown>;
  assertEquals(fin.p_status, "error");
  assertEquals(fin.p_input_tokens, 0);
});

Deno.test("CORS: preflight origin hợp lệ ⇒ 204; origin lạ ⇒ 403", async () => {
  const { fetch } = makeFetch({});
  const h = m.createHandler({ env: makeEnv(), fetch, log: silent });
  const pre = await h(
    new Request(`${SB}/functions/v1/scan-goofish`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Headers": "authorization, x-client-info, apikey, content-type",
      },
    }),
  );
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assertEquals(pre.headers.get("access-control-allow-headers"), "authorization, x-client-info, apikey, content-type");

  const bad = await h(post(textBody, { Origin: "https://evil.example" }));
  assertEquals(bad.status, 403);
  assertEquals(bad.headers.get("access-control-allow-origin"), null);
});
