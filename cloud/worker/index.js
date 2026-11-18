import { allowed, tools, validateArguments } from './toolbox.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const fail = text => ({ isError: true, content: [{ type: 'text', text }] });

const page = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeaDraw MCP</title>
<style>
body{margin:0;background:#f5f1e9;color:#252b34;font:17px/1.8 system-ui}
main{max-width:680px;margin:10vh auto;padding:28px}
small{color:#807358}h1{font-size:42px;line-height:1.2}
section{background:white;border-radius:18px;padding:24px;margin:24px 0;box-shadow:0 12px 40px #352e2312}
button{border:0;background:#284e57;color:white;border-radius:10px;padding:12px 20px;cursor:pointer}
#status{font-weight:700}.tools{color:#4e5965}
</style>
<main>
  <small>和 AI 一起茶绘 · 本机 Photoshop</small>
  <h1>TeaDraw MCP</h1>
  <p>让 AI 看见刚发生的画布变化，并在自己的图层上接着画。</p>
  <section>
    <div id="status">正在检查电脑连接…</div>
    <p class="tools">包含画布变化长轮询、局部预览、显式保存与导出、文档切换、文字、增强画笔与橡皮、图层组、尺寸操作、revision 冲突保护和轻量协作 session。所有编辑都锁定文档 ID；不开放任意脚本或远程打开本机文件，也不会静默覆盖文件。</p>
    <button onclick="check()">刷新连接</button>
  </section>
  <p>在聊天中选择对应插件并说“开始共同绘画”，AI 就可以读取 revision、等待你的下一笔，再根据 dirty bounds 获取局部预览。</p>
  <small>变化检测使用外部短采样，不会用长脚本阻塞 Photoshop；同一采样间隔内的多笔可能合并为一个回合 revision。</small>
</main>
<script>
async function check(){try{let r=await fetch('/status');if(!r.ok)throw Error();let s=await r.json();document.getElementById('status').textContent=s.online?'电脑连接在线 · 可在聊天中读取和编辑':'电脑连接离线 · 请启动本机连接程序'}catch{document.getElementById('status').textContent='暂时无法读取连接状态'}}check();
</script>
</html>`;

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === '/' && req.method === 'GET') return new Response(page, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } });
    if (!env.BUCKET) return json({ error: 'Storage unavailable' }, 503);
    const read = async key => {
      const object = await env.BUCKET.get(key);
      return object ? object.json() : null;
    };
    if (path === '/status') {
      const heartbeat = await read('heartbeat');
      return json({ online: !!heartbeat && Date.now() - heartbeat.at < 15000 });
    }

    // Owner-private Sites dispatch authenticates both visitors and the device credential.
    if (path.startsWith('/bridge/') && req.method === 'POST') {
      if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'JSON required' }, 415);
      if (path === '/bridge/heartbeat') {
        await env.BUCKET.put('heartbeat', JSON.stringify({ at: Date.now() }));
        return json({ ok: true });
      }
      if (path === '/bridge/poll') {
        await env.BUCKET.put('heartbeat', JSON.stringify({ at: Date.now() }));
        const pending = await env.BUCKET.list({ prefix: 'jobs/', limit: 100 });
        for (const object of pending.objects) {
          const job = await read(object.key);
          if (!job || job.expires < Date.now()) {
            await env.BUCKET.delete(object.key);
            continue;
          }
          await env.BUCKET.delete(object.key);
          return json(job);
        }
        for (const prefix of ['results/', 'active/']) {
          const old = await env.BUCKET.list({ prefix, limit: 100 });
          for (const object of old.objects) if (Date.now() - new Date(object.uploaded).getTime() > 180000) await env.BUCKET.delete(object.key);
        }
        return json({ idle: true });
      }
      if (path === '/bridge/result') {
        const raw = await req.text();
        if (raw.length > 2500000) return json({ error: 'Result too large' }, 413);
        let body;
        try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400); }
        if (!/^[a-f0-9-]{36}$/.test(body.id || '')) return json({ error: 'Invalid job' }, 400);
        const job = await read(`active/${body.id}`);
        if (!job || job.expires < Date.now()) return json({ error: 'Job expired' }, 410);
        if (!Array.isArray(body.result?.content) || body.result.content.some(item => !['text', 'image'].includes(item.type))) return json({ error: 'Invalid content' }, 400);
        await env.BUCKET.put(`results/${body.id}`, JSON.stringify(body.result));
        return json({ ok: true });
      }
    }

    if (!['/mcp', '/api/read'].includes(path) || req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const rawRpc = await req.text();
    if (rawRpc.length > 350000) return json({ error: 'Request too large' }, 413);
    let rpc;
    try { rpc = JSON.parse(rawRpc); } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (rpc.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
    const reply = result => json({ jsonrpc: '2.0', id: rpc.id ?? null, result });
    if (rpc.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28'], capabilities: { tools: {} } });
    if (rpc.method === 'initialize') return reply({ protocolVersion: rpc.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'photoshop', version: '0.3.0' } });
    if (rpc.method === 'ping') return reply({});
    if (rpc.method === 'tools/list') return reply({ tools });
    if (rpc.method !== 'tools/call') return json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } });
    const name = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    if (!allowed.has(name)) return reply(fail('Tool not allowed. Arbitrary scripts and remote opening of local files are not exposed. File writes require curated tools, an explicit absolute path, and an explicit overwrite flag.'));
    const argumentError = validateArguments(name, args);
    if (argumentError) return reply(fail(`Invalid tool arguments: ${argumentError}`));
    const heartbeat = await read('heartbeat');
    if (!heartbeat || Date.now() - heartbeat.at > 15000) return reply(fail('电脑连接离线。请启动 Windows 连接程序，然后重试。'));
    const id = crypto.randomUUID();
    const job = { id, name, arguments: args, expires: Date.now() + 180000 };
    await env.BUCKET.put(`active/${id}`, JSON.stringify(job));
    await env.BUCKET.put(`jobs/${id}`, JSON.stringify(job));
    try {
      for (let attempt = 0; attempt < 320; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const result = await read(`results/${id}`);
        if (result) return reply(result);
      }
      return reply(fail('Photoshop 响应超时。请检查 Photoshop 是否被对话框阻塞；超时任务可能仍在本机排队，先检查状态再决定是否重试。'));
    } finally {
      await Promise.all(['jobs/', 'results/', 'active/'].map(prefix => env.BUCKET.delete(prefix + id)));
    }
  },
};
