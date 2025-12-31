FROM alfg/nginx-rtmp:latest

COPY nginx.conf /etc/nginx/nginx.conf

# Base image entrypoint renders its own template and can overwrite nginx.conf.
# Override it so our config is the one actually running.
ENTRYPOINT ["nginx", "-g", "daemon off;"]
