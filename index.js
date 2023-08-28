const { Server } = require ("socket.io");
const { io } = require("socket.io-client");
require('dotenv').config();
const { exec } = require("child_process");
let servers;
let voteOptions = {};
let votedServers = [];
let voteInterval;
let finishedServers = [];
let finishedServersInterval;
let pending = true;
let timeoutInterval;
/*eslint no-undef:*/

init();

function init()
{
    calculateVariables();
    checkIfMariaDBIsRunning();
}

//mariadb should not be running, it should be disabled on server startup
//by using sytemctl disable mariadb, but if it is running, we stop it here if the env variable CAN_STOP_MARIADB is set to true
function checkIfMariaDBIsRunning()
{
    exec('sudo systemctl is-active mariadb', (error) => {
        if (error) {
            //command returns exit code 3: the process is not running
            startVoteSocket();
            return;
        }
        if(process.env.CAN_STOP_MARIADB){
            console.log("MariaDB is running, stopping it now");
            exec('sudo systemctl stop mariadb', (error) => {
                if (error) {
                    console.log(error);
                    return;
                }
                console.log("MariaDB stopped");
                startVoteSocket();
            });
        } else {
            console.log("MariaDB is running, please stop it before running this script");
            process.exit(1);
        }
    });
}

//looks in the env file for all server ips the cluster has and creates an object with the ips as keys and the votes as values
function calculateVariables(){
    servers = process.env.SERVERS.split(",");
    servers.forEach((server) => {
        voteOptions[server] = {
            votes: 0,
        }
    });
}

//starts the voting process by picking a random server and sending the vote to all other servers
function startVoteSocket()
{
    let vote = servers[Math.floor(Math.random() * servers.length)];
    voteOptions[vote].votes++;
    let serversToSendVotesTo = servers.filter((server) => {
        return server !== process.env.SERVER_IP
    });
    const srv = new Server(process.env.VOTE_PORT);
    srv.on("connection", (socket) => {
        srv.emit("vote", {vote: vote, server: process.env.SERVER_IP});
        socket.on("winner", () => {
            socket.disconnect();
            controller();
        });
    })
    serversToSendVotesTo.forEach((server) => {
        let addr = `ws://${server}:${process.env.VOTE_PORT}`;
        let socket = io(addr);
        socket.on("vote", (data) => {
            if(!votedServers.includes(data.server)){
                voteOptions[data.vote].votes++;
                votedServers.push(data.server);
            }
        });
    });
    watchVotedServers();
    startTimeoutInterval();
    console.log("voting process started, waiting for all servers to vote");
}

//checks if all servers have voted and if so, picks the winner
function watchVotedServers(){
    voteInterval = setInterval(() => {
        pending = true;
        if(votedServers.length === servers.length - 1){
            pending = false;
            clearInterval(timeoutInterval);
            clearInterval(voteInterval);
            let winner = Object.keys(voteOptions).reduce((a, b) => voteOptions[a].votes > voteOptions[b].votes ? a : b);
            if(winner !== process.env.SERVER_IP){
                worker(winner);
            } else {
                let addr = `ws://${winner}:${process.env.VOTE_PORT}`;
                io(addr).emit("winner", {winner: winner});
            }
        }
    }, 1000);
}

//The server that won the voting round will manage the other servers during the script
//Here we ask all the other servers to identify themselves and then request their grastates
function controller()
{
    console.log('starting as controller server');
    const srv = new Server(process.env.COMMAND_PORT);  
    let workers = []; 
    srv.on("connection", (socket) => {
        socket.emit("identify");
        socket.on("identify", (data) => {
            data.socket = socket;
            workers.push(data);
            if(workers.length === servers.length - 1){
                requestGrastates(workers);
            }
        });
    });
}
//For every "worker" server we request the grastate and then compare them to find the server that is safe to bootstrap
function requestGrastates(workers)
{
    let states = []
    exec(`sudo cat ${process.env.GRASTATE_LOCATION}`, (error, stdout) => {
        if (error) {
            console.log(error);
            return;
        }
        states.push({
            grastate: stdout.replace(" ", "").split("\n"), 
            ip: process.env.SERVER_IP
        })
        workers.forEach((worker) => {
            worker.socket.emit("command", {command: `sudo cat ${process.env.GRASTATE_LOCATION}`});
            worker.socket.on("data", (data) => {
                states.push(data)
                if(states.length === servers.length){
                    console.log("all states received");
                    compareGrastates(workers, states);
                }
            });
        });
    });
}
//Here we compare the grastates and find the server that is safe to bootstrap
//we check the safe_to_bootstrap variable and if it is 1, we start the cluster on that server
//if not, we check the seqno variable and pick the server with the highest seqno
function compareGrastates(workers, states)
{
    let parsedStates = []
    //parse the grastates to find the safe_to_bootstrap and seqno variables
    states.forEach((server => {
        server.seqno = server.grastate.filter((line) => {
            return line.includes("seqno")
        })[0];
        server.safeToBootstrap = server.grastate.filter((line) => {
            return line.includes("safe_to_bootstrap")
        })[0];
        if(parseInt(server.safeToBootstrap.slice(-1)) === 1){
            server.thisOneIsSafe = true;
        }else{
            server.thisOneIsSafe = false;
            server.seqno = parseInt(server.seqno.match(/seqno:\s*(-?\d+)/)[1]);
        }
        parsedStates.push(server);
    }));
    //check the parsed results and start the cluster
    if (parsedStates.some(server => server.thisOneIsSafe)){
        let safeServer = parsedStates.filter((server) => {
            return server.thisOneIsSafe
        })[0];
        startCluster(safeServer, workers);
    } else {
        if(parsedStates.every(server => server.seqno === -1)){
            //no good startup order on the cluster so
            //start the cluster on the "controller" node, followed by the other nodes
            console.log("no good startup order found, starting cluster recovery on this node");
            exec(`sudo sed -i 's/safe_to_bootstrap: 0/safe_to_bootstrap: 1/' /var/lib/mysql/grastate.dat`, (error) => {
                if(error){
                    console.log(error);
                    return;
                }
                exec('sudo galera_new_cluster', (error) => {
                    if (error) {
                        console.log(error);
                        return;
                    }
                    finishedServers.push(process.env.SERVER_IP);
                    console.log("cluster recovery finished on this node");
                    workers.forEach((worker) => {
                        console.log("starting mariadb on " + worker.ip);
                        worker.socket.emit("command", {command: `sudo systemctl start mariadb`});
                        worker.socket.on("finished", () => {
                            finishedServers.push(worker.ip);
                        });
                    });
                    watchClusterServers(workers);
                });
            });
        } else {
            //a safe order is available so we pick the server with the highest seqno as safeServer and then do the usual startup
            let safeServer = parsedStates.reduce((a, b) => a.seqno > b.seqno ? a : b);
            startCluster(safeServer, workers);
        }
    }
}
//Here we start the Galera cluster on the server that is safe to bootstrap
//We also start the mariadb process on all the other servers, allowing them to join the cluster
async function startCluster(safeServer, workers)
{
    if(safeServer.ip === process.env.SERVER_IP){
        exec(`sudo galera_new_cluster`, (error) => {
            console.log("starting galera cluster on this server");
            if (error) {
                console.log(error);
            }
            finishedServers.push(process.env.SERVER_IP);
            workers.forEach((worker) => {
                console.log("starting mariadb on " + worker.ip);
                worker.socket.emit("command", {command: `sudo systemctl start mariadb`});
                worker.socket.on("finished", () => {
                    finishedServers.push(worker.ip);
                });
            });
        });
    } else {
        //if the safeServer is not the controller server, we send the command to the safeServer and wait for it to finish
        let safeWorker = workers.filter((worker) => {
            return worker.ip === safeServer.ip
        })[0];
        console.log("starting galera cluster on " + safeServer.ip);
        safeWorker.socket.emit("command", {command: `sudo galera_new_cluster`})
        safeWorker.socket.on("data", () => {
            finishedServers.push(safeServer.ip);
            console.log("starting mariadb on this server");
            exec(`sudo systemctl start mariadb`, (error) => {
                if (error) {
                    console.log(error);
                }
                finishedServers.push(process.env.SERVER_IP);
                let otherWorkers = workers.filter((worker) => {
                    return worker.ip !== safeServer.ip
                });
                otherWorkers.forEach((worker) => {
                    console.log("starting mariadb on " + worker.ip);
                    worker.socket.emit("command", {command: `sudo systemctl start mariadb`});
                    worker.socket.on("finished", () => {
                        finishedServers.push(worker.ip);
                    });
                });
            });
        });
    }
    watchClusterServers(workers);
}

//This is used to check if all the servers have finished starting the mariadb process, if so, we exit the script
function watchClusterServers(workers)
{
    finishedServersInterval = setInterval(() => {
        if(finishedServers.length === servers.length){
            clearInterval(finishedServersInterval);
            console.log("all servers finished, cluster should be running");
            workers.forEach((worker) => {
                worker.socket.emit("exit");
            });
            process.exit(0);
        }
    }, 1000);
}

//This is used on the servers that lost the voting round, they send information to the controller
function worker(controllerAddr)
{
    let client = io(`ws://${controllerAddr}:${process.env.COMMAND_PORT}`);
    client.on("connect", () => {
        client.on("identify", () => {
            client.emit("identify", {ip: process.env.SERVER_IP});
        });
        client.on("command", (data) => {
            console.log(`executing command:  ${data.command}`)
            switch (data.command){
                case `sudo cat ${process.env.GRASTATE_LOCATION}`:
                    exec(data.command, (error, stdout) => {
                        if (error) {
                            client.emit("data", {error: error});
                            return;
                        }
                        client.emit("data", {
                            grastate: stdout.replace(" ", "").split("\n"), 
                            ip: process.env.SERVER_IP
                        });
                    });
                    break;
                case 'sudo galera_new_cluster':
                    exec(data.command, (error, stdout) => {
                        client.emit("data", {stdout: stdout});
                        return;
                    });
                    break;
                case 'sudo systemctl start mariadb':
                    exec(data.command, (error, stdout) => {
                        client.emit("finished", {stdout: stdout});
                        return;
                    });
                    break;
                default:
                    exec(data.command, (error, stdout) => {
                        if (error) {
                            client.emit("data", {error: error});
                            return;
                        }
                        client.emit("data", {stdout: stdout});
                    });
                    break;
            }
        });
        client.on('exit', () => {
            process.exit(0);
        });
    });
}

//if the voting process takes too long, we start mariadb cluster on this server, 
//this is probably because only this server went down and the cluster is running with 2 instances
function startTimeoutInterval()
{
    timeoutInterval = setInterval(() => {
        if(pending){
            clearInterval(timeoutInterval);
            clearInterval(voteInterval);
            console.log("timeout, starting cluster recovery on this node");
            exec(`sudo systemctl start mariadb`, (error) => {
                if (error) {
                    console.log(error);
                }
                process.exit(0);
            });
        }
    }, 120000);
}