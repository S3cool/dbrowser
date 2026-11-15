// netlify/functions/proxy.js
// Netlify 서버리스 함수 기반 리버스 프록시 (iframe 임베딩 및 상대 경로 보정)

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return true;
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(h)) return true;
  return false;
}

exports.handler = async function (event) {
  const target = event.queryStringParameters && event.queryStringParameters.url;
  if (!target) {
    return { statusCode: 400, body: 'Missing url parameter' };
  }

  let parsed;
  try {
    parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { statusCode: 400, body: 'Invalid protocol' };
    }
    if (isBlockedHost(parsed.hostname)) {
      return { statusCode: 403, body: 'Blocked private host' };
    }
  } catch (e) {
    return { statusCode: 400, body: 'Invalid URL' };
  }

  try {
    const resp = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      redirect: 'follow'
    });

    const finalUrl = resp.url || parsed.toString();
    const contentType = resp.headers.get('content-type') || 'application/octet-stream';

    // HTML 문서인 경우 <base href> 삽입 및 링크/폼 이동 가로채기 스크립트 주입
    if (contentType.includes('text/html')) {
      let html = await resp.text();
      const baseTag = `<base href="${finalUrl.replace(/"/g, '&quot;')}">`;
      const hookScript = `
<script>
(function(){
  var proxyBase = "/.netlify/functions/proxy?url=";
  function toProxy(u) {
    try {
      var abs = new URL(u, document.baseURI).toString();
      if (!/^https?:/i.test(abs)) return u;
      return proxyBase + encodeURIComponent(abs);
    } catch (e) { return u; }
  }
  document.addEventListener("click", function(e) {
    var a = e.target.closest("a[href]");
    if (!a) return;
    var raw = a.getAttribute("href");
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return;
    e.preventDefault();
    var abs = new URL(raw, document.baseURI).toString();
    try { window.parent.postMessage({ type: "dbrowser-nav", url: abs }, "*"); } catch (err) {}
    location.href = toProxy(abs);
  }, true);
  document.addEventListener("submit", function(e) {
    var f = e.target;
    if (!f || (f.method && f.method.toLowerCase() !== "get")) return;
    e.preventDefault();
    var action = new URL(f.getAttribute("action") || document.baseURI, document.baseURI);
    var fd = new FormData(f);
    fd.forEach(function(v, k) { action.searchParams.set(k, v); });
    var abs = action.toString();
    try { window.parent.postMessage({ type: "dbrowser-nav", url: abs }, "*"); } catch (err) {}
    location.href = toProxy(abs);
  }, true);
})();
</script>`;

      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => m + baseTag + hookScript);
      } else {
        html = baseTag + hookScript + html;
      }

      return {
        statusCode: resp.status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        },
        body: html
      };
    }

    // CSS, JS, 이미지 등 바이너리/정적 리소스 반환
    const buf = Buffer.from(await resp.arrayBuffer());
    return {
      statusCode: resp.status,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300'
      },
      body: buf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: 'Proxy fetch error: ' + (err && err.message ? err.message : String(err))
    };
  }
};
