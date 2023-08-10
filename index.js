const { Server } = require ("socket.io");
const { io } = require("socket.io-client");
require('dotenv').config();
const { exec } = require("child_process");
let servers;
let voteOptions = {};
let votedServers = [];
let voteInterval;

init();

//script entrypoint
function init()
{
    calculateVariables();
    startVoteSocket();
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
        socket.on("winner", (data) => {
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
}

//checks if all servers have voted and if so, picks the winner
function watchVotedServers(){
    voteInterval = setInterval(() => {
        if(votedServers.length === servers.length - 1){
            clearInterval(voteInterval);
            winner = Object.keys(voteOptions).reduce((a, b) => voteOptions[a].votes > voteOptions[b].votes ? a : b);
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
    console.log('starting as controller');
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
    exec(`cat ${process.env.GRASTATE_LOCATION}`, (error, stdout, stderr) => {
        if (error) {
            console.log(error);
            return;
        }
        states.push({
            grastate: stdout.replace(" ", "").split("\n"), 
            ip: process.env.SERVER_IP
        })
        workers.forEach((worker) => {
            worker.socket.emit("command", {command: `cat ${process.env.GRASTATE_LOCATION}`});
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
            exec('galera_recovery', (error, stdout, stderr) => {
                if (error) {
                    console.log(error);
                    return;
                }
                workers.forEach((worker) => {
                    worker.socket.emit("command", {command: `systemctl start mariadb`});
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
function startCluster(safeServer, workers)
{
    if(safeServer.ip === process.env.SERVER_IP){
        exec(`galera_new_cluster`, (error, stdout, stderr) => {
            if (error) {
                console.log(error);
            }
            workers.forEach((worker) => {
                worker.socket.emit("command", {command: `systemctl start mariadb`});
            });
        });
    } else {
        let safeWorker = workers.filter((worker) => {
            return worker.ip === safeServer.ip
        })[0];
        safeWorker.socket.emit("command", {command: `galera_new_cluster`})
        safeWorker.socket.on("data", (data) => {
            exec(`systemctl start mariadb`, (error, stdout, stderr) => {
                if (error) {
                    console.log(error);
                }
            });
            let otherWorkers = workers.filter((worker) => {
                return worker.ip !== safeServer.ip
            });
            otherWorkers.forEach((worker) => {
                worker.socket.emit("command", {command: `systemctl start mariadb`});
            });
        });
    }
    workers.forEach((worker) => {
        worker.socket.emit("exit");
    });
    console.log('cluster started');
    process.exit(0);
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
            if(data.command == `cat ${process.env.GRASTATE_LOCATION}`){
                exec(data.command, (error, stdout, stderr) => {
                    if (error) {
                        client.emit("data", {error: error});
                        return;
                    }
                    client.emit("data", {
                        grastate: stdout.replace(" ", "").split("\n"), 
                        ip: process.env.SERVER_IP
                    });
                });
            } else if(data.command == `galera_new_cluster`){
                exec(data.command, (error, stdout, stderr) => {
                    client.emit("data", {stdout: stdout});
                });
            } else {
                exec(data.command, (error, stdout, stderr) => {
                    if (error) {
                        client.emit("data", {error: error});
                        return;
                    }
                    client.emit("data", {stdout: stdout});
                });
            }
        });
        client.on('exit', () => {
            process.exit(0);
        });
    });
}