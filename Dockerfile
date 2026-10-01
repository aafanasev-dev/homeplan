FROM nginx:1.27-alpine
COPY index.html style.css /usr/share/nginx/html/
COPY js/ /usr/share/nginx/html/js/
EXPOSE 80
