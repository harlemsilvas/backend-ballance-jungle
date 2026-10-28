// Serve only the generated dashboard: never expose the repository or .env.
const port = Number(process.env.REPORT_PORT ?? '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_REPORT_PORT');
async function main() {
const dashboard = Bun.file('reports/dashboard.html');
if (!await dashboard.exists()) throw new Error('DASHBOARD_NOT_BUILT');
const server = Bun.serve({ hostname: process.env.REPORT_HOST ?? '127.0.0.1', port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405});
    if (path === '/health') return new Response('ok');
    if (path !== '/') return new Response('Not found',{status:404});
    return new Response(dashboard,{headers:{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
  }
});
console.log(`Relatórios: http://127.0.0.1:${server.port}`);

}
void main();
