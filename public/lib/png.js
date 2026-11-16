// A 16×16 solid-colour PNG, built by hand so the generated script needs no image tools.
// The deflate stream is a single stored (uncompressed) block, which every decoder accepts.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (const x of bytes) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function chunk(type, data) {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const body = [...typeBytes, ...data];
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

export function solidPng(hex, size = 16) {
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a colour: ${hex}`);
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0); // filter: none
    for (let x = 0; x < size; x++) raw.push(...rgb);
  }
  const len = raw.length; // well under 65535, so one stored block
  const zlib = [0x78, 0x01, 0x01, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255, ...raw, ...u32(adler32(raw))];
  const ihdr = [...u32(size), ...u32(size), 8, 2, 0, 0, 0];
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlib),
    ...chunk('IEND', []),
  ]);
}

export function solidPngBase64(hex) {
  let s = '';
  for (const b of solidPng(hex)) s += String.fromCharCode(b);
  return btoa(s);
}
