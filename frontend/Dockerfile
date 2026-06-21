# Static frontend served by nginx. No build step — plain HTML/CSS/JS.
# nginx also reverse-proxies /api/* to the backend service (see nginx.conf).
FROM nginx:1.27-alpine

# Replace the default server block with ours (static + /api proxy).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the static assets.
COPY index.html styles.css app.js /usr/share/nginx/html/

EXPOSE 80
