// 快速验证 worker.js 中 /api/gw/:gw/... 路由正则与分支逻辑
// 不跑真实 Cloudflare API，只验证路径分发

const re = /^\/api\/gw\/([^/]+)(\/routes(?:\/([^/]+))?(\/(versions|deployments)(?:\/([^/]+))?)?)?$/;

const cases = [
  // [path, expected]
  ["/api/gw/pockoo", { gw: "pockoo", rid: undefined, sub: undefined, subId: undefined }],
  ["/api/gw/pockoo/routes", { gw: "pockoo", rid: undefined, sub: undefined, subId: undefined }],
  ["/api/gw/pockoo/routes/abc", { gw: "pockoo", rid: "abc", sub: undefined, subId: undefined }],
  ["/api/gw/pockoo/routes/abc/versions", { gw: "pockoo", rid: "abc", sub: "versions", subId: undefined }],
  ["/api/gw/pockoo/routes/abc/versions/v1", { gw: "pockoo", rid: "abc", sub: "versions", subId: "v1" }],
  ["/api/gw/pockoo/routes/abc/deployments", { gw: "pockoo", rid: "abc", sub: "deployments", subId: undefined }],
  ["/api/gw/pockoo/routes/abc/deployments/d1", { gw: "pockoo", rid: "abc", sub: "deployments", subId: "d1" }],
  ["/api/gw/pockoo/routes/19670e16-20ab-423f-918f-8fdadbd7a273/versions/7d24267f", { gw: "pockoo", rid: "19670e16-20ab-423f-918f-8fdadbd7a273", sub: "versions", subId: "7d24267f" }],
  // 不应匹配
  ["/api/gw/pockoo/routes/abc/versions/v1/extra", null],
  ["/api/gw/pockoo/routes/abc/unknown", null],
];

let ok = 0, fail = 0;
for (const [path, expected] of cases) {
  const m = path.match(re);
  const actual = m ? { gw: m[1], rid: m[3], sub: m[5], subId: m[6] } : null;
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) { ok++; console.log("PASS", path, "=>", actual); }
  else { fail++; console.log("FAIL", path, "=>", actual, "expected", expected); }
}
console.log(`\n${ok} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
