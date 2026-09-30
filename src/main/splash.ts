// Self-contained splash screen shown instantly while the main window loads.
export const SPLASH_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; -webkit-user-select: none; }
  .card {
    position: absolute; inset: 8px; border-radius: 18px;
    background: linear-gradient(150deg, #4f46e5 0%, #3730a3 55%, #1e1b4b 100%);
    box-shadow: 0 20px 50px rgba(0,0,0,.45);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    color: #fff;
  }
  .logo { width: 60px; height: 60px; border-radius: 16px; background: rgba(255,255,255,.14);
    display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.18); }
  .name { font-size: 20px; font-weight: 700; letter-spacing: .3px; }
  .sub { font-size: 12px; color: rgba(255,255,255,.7); display: flex; align-items: center; gap: 8px; }
  .spinner { width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
    animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="#fff" stroke="#fff"
           stroke-width="1.5" stroke-linejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    </div>
    <div class="name">ConnectD</div>
    <div class="sub"><span class="spinner"></span> Starting up…</div>
  </div>
</body>
</html>`
