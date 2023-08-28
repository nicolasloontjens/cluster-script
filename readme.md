## Galera cluster startup script

### Requirements:
- This script was made with NodeJS v18.12.1, behaviour might be different on other versions.
- A fully configured galera cluster should already be present on 3 servers this script will run on.

### Setup:
- npm install
- cp .env.example .env
- add server ip's, grastate.dat file location and the required ports
- modify /etc/sudoers with following data or configure your system to behave like the specified config:
```
# Allow user to execute all commands without password prompt
ocular ALL=(ALL) NOPASSWD: /usr/bin/systemctl
ocular ALL=(ALL) NOPASSWD: /usr/bin/cat
ocular ALL=(ALL) NOPASSWD: /usr/bin/sed
ocular ALL=(ALL) NOPASSWD: /usr/bin/galera_new_cluster
```
- run the script with ```node index.js````

### Extra:
A systemd service is also provided in this repo called ```galera-cluster-script.service```.\
This will run the script on server startup, the file paths of your NodeJS binary and this script repository might require adjustments.
The unit file should be placed under ```/etc/systemd/system/galera-cluster-script.service```

Alternatively you can use PM2 to configure this script to run at startup.\
https://pm2.keymetrics.io/