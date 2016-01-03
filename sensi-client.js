var EventEmitter = require("events").EventEmitter;
var merge = require("merge");
var request = require("request").defaults({"jar": true});
var util = require("util");

function SensiClient(options) {
    var self = this;
    
    self._baseUrl = options.baseUrl || "https://bus-serv.sensicomfort.com";
    self._password = options.password || "";
    self._pollingRetryCount = options.pollingRetryCount || 5;
    self._status = {};
    self._username = options.username || "";
    self._verbose = options.verbose || false;
}

util.inherits(SensiClient, EventEmitter);

SensiClient.prototype.connect = function(callback) {
    var self = this;
    
    self._log("Authorizing");
    self._authorize(function(err) {
        if (err) {
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        self._log("Retrieving thermostats");
        self._getThermostats(function(err, thermostats) {
            if (err) {
                if (callback) {
                    callback(err);
                }
                
                return;
            }
            
            self._thermostats = thermostats;
            
            self._log("Negotiating connection");
            self._negotiate(function(err, connectionToken) {
                if (err) {
                    if (callback) {
                        callback(err);
                    }
                    
                    return;
                }
                
                self._connectionToken = connectionToken;
                
                self._log("Connecting");
                self._connect(function(err, rsp) {
                    if (err) {
                        if (callback) {
                            callback(err);
                        }
                        
                        return;
                    }
                    
                    self._connected = true;
                    self._messageId = rsp.C;
                    
                    self._log("Connected!");
                    
                    callback(null, thermostats);
                });
            });
        });
    });
};

SensiClient.prototype.disconnect = function() {
    var self = this;
    
    self._log("Disconnecting");
    
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

SensiClient.prototype.subscribe = function(thermostat, callback) {
    var self = this;
    
    self._log("Subscribing to thermostat " + thermostat);
    
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
                    self._log("Abort polling, no longer connected...");
                    return;
                }
                
                self._poll(function(err) {
                    if (err) {
                        self._log("Error while polling:");
                        console.error(err);
                        
                        self._pollingRetryNumber++;
                        
                        if (self._pollingRetryNumber > self._pollingRetryCount) {
                            console.error("Too many retries, abort!");
                            return;
                        } else {
                            self._log("Retry " + self._pollingRetryNumber.toString() + 
                                " of " + self._pollingRetryCount.toString());
                        }
                        
                        if (err.name == "AuthorizationRequiredError") {
                            self._log("Attempting to reauthorize");
                            self._authorize(function(err) {
                                if (err) {
                                    console.error(err);
                                    return;
                                }
                                
                                self._log("Reauthorization successful, resume polling");
                                poll();
                            });
                        } else if (err.name == "SubscriptionExpiredError") {
                            self._log("Attempting to resubscribe");
                            self._subscribe(thermostat, (function(err) {
                                if (err) {
                                    console.err(err);
                                    return;
                                }
                                
                                self._log("Resubscription successful, resume polling");
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

SensiClient.prototype._log = function(message) {
    var self = this;
    
    if (self._verbose) {
        console.log(new Date().toString() + " [SensiClient ] " + message);
    }
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

SensiClient.prototype._poll = function(callback) {
    var self = this;
    
    self._log("Polling");
    
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
        self._log("Response received");
        self._log(body);
        
        if (err) {
            console.error(err);
            
            if (callback) {
                callback(err);
            }
            
            return;
        }
        
        if (rsp.statusCode != 200) {
            self._log("Sensi API returned statusCode " + rsp.statusCode.toString());
            
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
        
        self._log("Parsing response");
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

SensiClient.prototype._processMessage = function(data) {
    var self = this;
    
    if (data.H == "thermostat-v1") {
        var message = data.A[1] || {};
        message.ICD = data.A[0] || "";
        message.Timestamp = Date.now();
        
        if (data.M == "online") {
            self._processOnlineMessage(message);
            self.emit("online", message);
        } else if (data.M == "update") {
            self._processUpdateMessage(message);
            self.emit("update", message);
        } else if (data.M == "offline") {
            self.emit("offline", message);
        }
    } else {
        self._log("Received unknown message type!");
        console.log(data);
    }
};

SensiClient.prototype._processOnlineMessage = function(onlineMessage) {
    var self = this;
    
    self._status = merge.recursive(this._status, onlineMessage);
};

SensiClient.prototype._processUpdateMessage = function(updateMessage) {
    var self = this;
    
    // Check to see if the Running Mode has changed
    if (updateMessage.hasOwnProperty("OperationalStatus") &&
        self._status.hasOwnProperty("OperationalStatus")) {
            
        if (updateMessage.OperationalStatus.hasOwnProperty("Running") &&
            self._status.OperationalStatus.hasOwnProperty("Running")) {
                
            if (updateMessage.OperationalStatus.Running.hasOwnProperty("Mode") &&
                self._status.OperationalStatus.Running.hasOwnProperty("Mode")) {
                    
                if (updateMessage.OperationalStatus.Running.Mode != 
                    self._status.OperationalStatus.Running.Mode) {
                        
                    self.emit("runningModeChanged", {
                        oldMode: self._status.OperationalStatus.Running.Mode,
                        newMode: updateMessage.OperationalStatus.Running.Mode
                    });
                }
            }
        }
    }
    
    
    if (updateMessage.hasOwnProperty("EnvironmentControls") &&
        self._status.hasOwnProperty("EnvironmentControls")) {
            
            var isTemporaryHold = false;
            
            // Check to see if this is a temporary hold (i.e., not scheduled)
            if (updateMessage.EnvironmentControls.hasOwnProperty("HoldMode")) {
                
                if (updateMessage.EnvironmentControls.HoldMode == "Temporary") {
                    isTemporaryHold = true;
                }
            }
            
            // Check to see if the Cooling Setpoint has changed
            if (updateMessage.EnvironmentControls.hasOwnProperty("CoolSetpoint") &&
                self._status.EnvironmentControls.hasOwnProperty("CoolSetpoint")) {
                
                if (updateMessage.EnvironmentControls.CoolSetpoint.hasOwnProperty("F") &&
                    self._status.EnvironmentControls.CoolSetpoint.hasOwnProperty("F")) { 
                        
                    if (updateMessage.EnvironmentControls.CoolSetpoint.F != 
                        self._status.EnvironmentControls.CoolSetpoint.F) {
                        
                        self.emit("coolSetpointChanged", {
                            oldSetpoint: self._status.EnvironmentControls.CoolSetpoint.F,
                            newSetpoint: updateMessage.EnvironmentControls.CoolSetpoint.F,
                            isTemporaryHold: isTemporaryHold
                        });
                    }
                }
            }
            
            // Check to see if the Heating Setpoint has changed
            if (updateMessage.EnvironmentControls.hasOwnProperty("HeatSetpoint") &&
                self._status.EnvironmentControls.hasOwnProperty("HeatSetpoint")) {
                    
                if (updateMessage.EnvironmentControls.HeatSetpoint.hasOwnProperty("F") &&
                    self._status.EnvironmentControls.HeatSetpoint.hasOwnProperty("F")) {
                        
                    if (updateMessage.EnvironmentControls.HeatSetpoint.F != 
                        self._status.EnvironmentControls.HeatSetpoint.F) {
                            
                        self.emit("heatSetpointChanged", {
                            oldSetpoint: self._status.EnvironmentControls.HeatSetpoint.F,
                            newSetpoint: updateMessage.EnvironmentControls.HeatSetpoint.F,
                            isTemporaryHold: isTemporaryHold
                        });   
                    }
                }
            }
            
            // Check to see if the SystemMode has changed
            if (updateMessage.EnvironmentControls.hasOwnProperty("SystemMode") &&
                self._status.EnvironmentControls.hasOwnProperty("SystemMode")) {
            
                if (updateMessage.EnvironmentControls.SystemMode !=
                    self._status.EnvironmentControls.SystemMode) {
                
                    self.emit("systemModeChanged", {
                        oldMode: self._status.EnvironmentControls.SystemMode,
                        newMode: updateMessage.EnvironmentControls.SystemMode
                    });
                }
            };
    }
    
    this._status = merge.recursive(this._status, updateMessage);
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

module.exports = SensiClient;
