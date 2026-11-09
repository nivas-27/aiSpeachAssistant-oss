#!/usr/bin/env bash
# Root-only deploy steps for Fluently. Run once:  sudo bash deploy-root.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"

# 1. Frontend static files
mkdir -p /var/www/fluently
rsync -a --delete "$REPO/frontend/dist/" /var/www/fluently/

# 2. Nginx vhosts (same pattern as 'anand')
cat > /etc/nginx/sites-available/fluently <<'EOF'
server {
    listen 80;
    server_name fluently.nivasdev.in;
    root /var/www/fluently;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location /assets/ { expires 30d; add_header Cache-Control "public, immutable"; }
}
EOF
cat > /etc/nginx/sites-available/fluently-api <<'EOF'
server {
    listen 80;
    server_name fluently-api.nivasdev.in;
    client_max_body_size 50m;          # audio uploads
    location / {
        proxy_pass http://127.0.0.1:8130;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;       # LLM / TTS calls
        proxy_buffering off;           # streaming responses
    }
}
EOF
ln -sf /etc/nginx/sites-available/fluently     /etc/nginx/sites-enabled/fluently
ln -sf /etc/nginx/sites-available/fluently-api /etc/nginx/sites-enabled/fluently-api
nginx -t
systemctl reload nginx

# 3. Cloudflared ingress (insert before the catch-all 404)
CFG=/etc/cloudflared/config.yml
if ! grep -q fluently.nivasdev.in "$CFG"; then
  cp "$CFG" "$CFG.bak"
  python3 - "$CFG" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
add="""  - hostname: fluently.nivasdev.in
    service: http://localhost:80

  - hostname: fluently-api.nivasdev.in
    service: http://localhost:80

"""
s=s.replace("  - service: http_status:404", add+"  - service: http_status:404")
open(p,'w').write(s)
PY
  systemctl restart cloudflared
fi
echo "Done."
