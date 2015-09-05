var EventEmitter = require("events").EventEmitter;
var request = require("request").defaults({"jar": true});
var util = require("util");

function SensiClient(options) {
    this._username = options.username || "";
    this._password = options.password || "";
    this._baseUrl = options.baseUrl || "https://bus-serv.sensicomfort.com"; 
    this._pollingRetryCount = options.pollingRetryCount || 5;
}

util.inherits(SensiClient, EventEmitter);

var log = function(message) {
    console.log(new Date().toString() + " [SensiClient] " + message);
};

SensiClient.prototype.connect = function(callback) {
    var self = this;
    
    log("Authorizing");
    self._authorize(function(err) {
        if (err) {
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        self._connected = true;
        
        log("Retrieving thermostats");
        self._getThermostats(function(err, thermostats) {
            if (err) {
                if (callback) {
                    callback(err);
                }
                
                return;
            }
            
            self.thermostats = thermostats;
            
            log("Negotiating connection");
            self._negotiate(function(err, connectionToken) {
                if (err) {
                    if (callback) {
                        callback(err);
                    }
                    
                    return;
                }
                
                self._connectionToken = connectionToken;
                
                log("Connecting");
                self._connect(function(err, rsp) {
                    if (err) {
                        if (callback) {
                            callback(err);
                        }
                        
                        return;
                    }
                    
                    self._messageId = rsp.C;
                    
                    log("Connected!");
                    
                    callback(null);
                });
            });
        });
    });
};

SensiClient.prototype.subscribe = function(thermostat, callback) {
    var self = this;
    
    log("Subscribing to thermostat " + thermostat);
    
    self._subscribe(thermostat, function(err) {
        if (err) {
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        process.nextTick(function() {
            (function poll() {
                if (!self._connected) {
                    log("Disconnected, polling disabled");
                    return;
                }
                
                //TODO: This could be cleaned up a bit...
                self._poll(function(err) {
                    if (err) {
                        console.error(err);
                        self._pollingRetryNumber++;
                        
                        if (self._pollingRetryNumber > self._pollingRetryCount) {
                            log("Too many retries, abort!");
                            return;
                        } else {
                            log("Retry " + self._pollingRetryNumber.toString() + 
                                " of " + self._pollingRetryCount.toString());
                        }
                        
                        if (err.name == "AuthorizationRequiredError") {
                            log("Attempting to reauthorize");
                            self._authorize(function(err) {
                                if (err) {
                                    console.error(err);
                                    return;
                                }
                                
                                poll();
                            });
                        } else if (err.name == "SubscriptionExpiredError") {
                            log("Attempting to resubscribe");
                            self._subscribe(thermostat, (function(err) {
                                if (err) {
                                    console.err(err);
                                    return;
                                }
                                
                                poll();
                            }));
                        } else {
                            poll();
                        }
                    } else {
                        poll();
                    }
                });
            })();
        });
    });
};

SensiClient.prototype._authorize = function(callback) {
    var self = this;
    
    var options = {
        uri: self._baseUrl + "/api/authorize",
        method: "POST",
        json: {
            "UserName": self._username,
            "Password": self._password
        },
        headers: {
            "Accept": "application/json; version=1, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest"
        }
    };
    
    request(options, function(err, rsp, body) {
        if (err) {
            if (callback) {
                callback(err);
            }
                
            return;
        }
        
        if (rsp.statusCode != 200) {
            err = new Error(body.Message || "Authorization failure (" + rsp.statusCode.toString() + ")");
        
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        return callback();
    });
};

SensiClient.prototype._getThermostats = function(callback) {
    var self = this;
    
    var options = {
        uri: self._baseUrl + "/api/thermostats",
        headers: {
            "Accept": "application/json; version=1, */*; q=0.01"
        }
    };
    
    request(options, function(err, rsp, body) {
        if (err) {
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        if (rsp.statusCode != 200) {
            err = new Error(body.Message || "Failed to retrieve thermostat listing (" + rsp.statusCode.toString() + ")");
            
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        callback(null, JSON.parse(body));
    });
};

SensiClient.prototype._negotiate = function(callback) {
    var self = this;
    
    var options = {
        uri: self._baseUrl + "/realtime/negotiate",
        headers: {
            "Accept": "application/json; version=1, */*; q=0.01"
        }
    };
    
    request(options, function(err, rsp, body) {
        if (err) {
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        if (rsp.statusCode != 200) {
            err = new Error(body.Message || "Failed to negotiate connection (" + rsp.statusCode.toString() + ")");
            
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        callback(null, JSON.parse(body).ConnectionToken);
    });
};

SensiClient.prototype._connect = function(callback) {
    var self = this;
    
    var options = {
        uri: self._baseUrl + "/realtime/connect",
        headers: {
            "Accept": "application/json; version=1, */*; q=0.01"
        },
        qs: {
            transport: "longPolling",
            connectionToken: self._connectionToken,
            connectionData: '[{"name": "thermostat-v1"}]',
            tid: Math.floor(Math.random() * 11), // As per signalR
            _: Date.now()
        }
    };
    
    request(options, function(err, rsp, body) {
        if (err) {
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        if (rsp.statusCode != 200) {
            err = new Error(body.Message || "Failed to connect (" + rsp.statusCode.toString() + ")");

            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        callback(null, JSON.parse(body));
    });
};

SensiClient.prototype._subscribe = function(thermostat, callback) {
    var self = this;
    
    var options = {
        uri: self._baseUrl + "/realtime/send",
        headers: {
            "Accept": "application/json; version=1, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
        },
        qs: {
            transport: "longPolling",
            connectionToken: self._connectionToken
        },
        method: "POST",
        form: {
            data: JSON.stringify({
                    "H": "thermostat-v1",
                    "M": "Subscribe",
                    "A": [thermostat],
                    "I": 0
            })
        }
    };
    
    request(options, function(err, rsp, body) {
        if (err) {
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        if (rsp.statusCode != 200) {
            err = new Error(body.Message || "Failed to subscribe to " + thermostat + " (" + rsp.statusCode.toString() + ")");

            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        callback(null);
    });
    
};

SensiClient.prototype._poll = function(callback) {
    var self = this;
    
    log("Polling");
    
    var options = {
        uri: self._baseUrl + "/realtime/poll",
        headers: {
            "Accept": "application/json; version=1, */*; q=0.01"
        },
        qs: {
            transport: "longPolling",
            connectionToken: self._connectionToken,
            connectionData: '[{"name": "thermostat-v1"}]',
            groupsToken: self._groupsToken,
            messageId: self._messageId,
            tid: Math.floor(Math.random() * 11), // As per signalR
            _: Date.now()
        }
    };
    
    request(options, function(err, rsp, body) {
        log("Polling response received");
        console.log(body);
        
        if (err) {
            console.error(err);
            
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        if (rsp.statusCode != 200) {
            log("Sensi API returned statusCode " + rsp.statusCode.toString());
            
            err = new Error(body.Message || "Polling failure (" + rsp.statusCode.toString() + ")");
            
            if (rsp.statusCode == 401 || rsp.statusCode == 403) {
                err.name = "AuthorizationRequiredError";
            } else if (rsp.statusCode == 500) {
                err.name = "SubscriptionExpiredError";
            } else {
                err.name = "UnknownError";   
            }
            
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        self._pollingRetryNumber = 0;
        
        log("Parsing response");
        var pollResponse = JSON.parse(body);
        
        if (pollResponse.C) {
            self._messageId = pollResponse.C;
        }
        
        if (pollResponse.G) {
            self._groupsToken = pollResponse.G;
        }
        
        if (pollResponse.M) {
            pollResponse.M.forEach(function(message) {
                self._processMessage(message);                
            });
        }
        
        callback(null);
    });
};

SensiClient.prototype._processMessage = function(message) {
    var self = this;
    
    if (message.H == "thermostat-v1") {
        var data = message.A[1] || {};
        data.ICD = message.A[0] || "";
        data.Timestamp = Date.now();
        
        if (message.M == "online") {
            self.emit("online", data);
        } else if (message.M == "update") {
            self.emit("update", data);
        } else if (message.M == "offline") {
            self.emit("offline", data);
        }
    } else {
        log("Received unknown message type!");
        console.log(message);
    }
};

SensiClient.prototype.disconnect = function() {
    var self = this;
    
    log("Disconnecting");
    
    self._connected = false;
    
    var options = {
        uri: self._baseUrl + "/realtime/abort",
        headers: {
            "Accept": "application/json; version=1, */*; q=0.01"
        },
        qs: {
            transport: "longPolling",
            connectionToken: self._connectionToken
        }
    };
    
    request(options, function(err, rsp, body) {
        if (err) {
            console.error(err);
        }
        
        if (rsp.statusCode != 200) {
            err = new Error(body.Message || "Polling failure (" + rsp.statusCode.toString() + ")");
            console.error(err);
        }
    });
};

module.exports = SensiClient;