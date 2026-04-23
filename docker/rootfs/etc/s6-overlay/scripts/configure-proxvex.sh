# if they are mounted, ensure required directories have correct ownership as 
# this script runs as root
# Migration from old config location /data/local to /config/proxvex
# If /config/proxvex does not exist, copy configuration from /data/local
# shellcheck disable=SC2012
if [ ! -d "/config/proxvex" ] || \
   [ ! -f "/config/proxvex/proxvex.yaml" ]  ||
   [ "$(find /config/proxvex/busses/bus.*/s*.yaml | wc -l)" = "0" ]
then
    mkdir -p /config/proxvex; 
    if [ -d /data/local ]  
    then 
      mkdir -p /config/proxvex; 
      echo "Migrating /data and /config to new command line 0.17.0+"
      cp -R /data/local/* /config/proxvex/; 
    fi
fi
mkdir -p /config/proxvex; 
[ ! -d "/data/public" ] && mkdir -p /data/public; 
chown -R proxvex:dialout /config/proxvex
chown -R proxvex:dialout /data/public
touch /ssl/secrets.txt
chown -R proxvex:dialout /ssl/secrets.txt
git config --global --add safe.directory /data/public
