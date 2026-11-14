/** AWS Signature Version 4 with WebCrypto (Amazon Polly needs it; there is no AWS SDK in the Worker). */

const enc = new TextEncoder();

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256(data: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** RFC 3986 encoding, as SigV4 wants it. */
const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  service: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date?: Date;
}

/** The headers to add to the request: `authorization` and `x-amz-date`. */
export async function signV4(input: SignInput): Promise<{ authorization: string; "x-amz-date": string }> {
  const u = new URL(input.url);
  const amzDate = (input.date ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  headers.host = u.host;
  headers["x-amz-date"] = amzDate;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");

  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = u.pathname.split("/").map((p) => uriEncode(decodeURIComponent(p))).join("/") || "/";

  const canonical = [input.method.toUpperCase(), path, query, ...names.map((n) => `${n}:${headers[n]}`), "", signedHeaders, await sha256(input.body)].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");

  let k = await hmac(enc.encode(`AWS4${input.secretAccessKey}`), day);
  k = await hmac(k, input.region);
  k = await hmac(k, input.service);
  k = await hmac(k, "aws4_request");
  const signature = hex(await hmac(k, toSign));

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
  };
}
