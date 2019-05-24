/**
 *
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

(function () {
    'use strict';

    var deps = ['lib/underscore', 'backbone', 'jwt_decode', 'app/js/model/login', 'lib/moment', 'app/js/tools/alert.view', 'lib/backbone-localstorage'];
    define(deps, function (_, Backbone, jwtDecode, LoginModel, moment, AlertView) {
        var AuthModel = Backbone.Model.extend({
            id: 'ux.auth',
            localStorage: new Store('ux.auth'),
            defaults: {
                auth: false,
                username: '',
                email: '',
                groups: '',
                jug: '',

                access_token: '',
                access_exp: '',

                token_type: '',
                expires_in: '',

                refresh_token: '',
                refresh_exp: ''
            },
            loginModel: null,
            chRef: null,
            initialize: function () {
                var me = this;
                me.loginModel = new LoginModel();
                me.chRef = _.throttle(me.checkRefresh, 500);
                // Simplest way to inject Authorization header for jQuery
                /*$.ajaxSetup({
                    beforeSend: function (jqXHR) {
                        var access_token = me.get('access_token'), token_type = me.get('token_type') + " ";
                        if (typeof access_token !== 'undefined' && !!access_token) {
                            jqXHR.setRequestHeader('Authorization', token_type + access_token);
                        }
                    }
                });*/

                $.ajaxTransport("+*", function (options, originalOptions, jqXHR) {
                    me.chRef();
                    if (!originalOptions.ignoreTransport) {
                        const transport = {
                            options,
                            originalOptions,
                            jqXHR,
                            cb: null,
                            abort: function (message) {
                                this.cb(400, message || 'request failed');
                            },
                            send: function (retryRequest) {
                                if (me.loggingOut) return this.abort();

                                // Another way to inject Authorization header
                                const access_token = me.get('access_token'), token_type = me.get('token_type') + " ";
                                if (typeof access_token !== 'undefined' && !!access_token) {
                                    this.originalOptions.headers = {
                                        ...this.originalOptions.headers,
                                        authorization: token_type + access_token
                                    };
                                }
                                $.ajax({
                                    ...this.originalOptions,
                                    ignoreTransport: true,
                                    retryRequest
                                }).done((data, status, xhr) => {
                                    this.cb(200, status, {text: xhr.responseText, JSON: xhr.responseJSON});
                                }).fail(xhr => {
                                    if (me.loggingOut) return this.abort();

                                    const now = moment().valueOf(),
                                        refresh_exp = me.get('refresh_exp'),
                                        leftRe = (refresh_exp - now);
                                    if (!refresh_exp || leftRe < 0) {
                                        me.logoutAndWarn(xhr);
                                    } else if (me.checkRefStatus) {
                                        setTimeout(() => {
                                            this.send(0);
                                        }, 200);
                                    } else if (xhr.status === 401 && retryRequest < 2) {
                                        me.checkRefStatus = true;
                                        me.refresh()
                                            .then(() => this.send(retryRequest + 1))
                                            .catch(e => me.logoutAndWarn(e))
                                            .then(() => me.checkRefStatus = false);
                                    } else {
                                        this.abort();
                                    }
                                });
                            }
                        };
                        return {
                            send: function (headers, cb) {
                                transport.cb = cb;
                                transport.send(0);
                            },
                            abort: function () {
                                transport.abort();
                            }
                        };
                    }
                });

                var originalNavigate = Backbone.history.navigate;
                Backbone.history.navigate = function (fragment, options) {
                    originalNavigate.apply(this, arguments);
                };
            },
            loggingOut: false,
            logoutAndWarn: function (e) {
                var me = this;
                if (me.loggingOut) return;

                const message = e && e.responseJSON && e.responseJSON.error_description;
                me.loggingOut = true;

                me.logout().then(
                    function () {
                        if (!window.BackboneApp) return window.open('login', "_self", false);
                        const router = window.BackboneApp.getRouter();
                        router.navigate('login', {
                            trigger: true
                        });
                        AlertView.show('Warning', message || 'Your access has expired', 'warning');
                        setTimeout(() => me.loggingOut = false, 300);
                    }
                );
            },
            checkRefStatus: false,
            checkRefresh: function () {
                var me = this;
                if (!window.BackboneApp || me.checkRefStatus) return;

                me.checkRefStatus = true;
                me.getAuth()
                    .then(function () {
                        const now = moment().valueOf(),
                            access_exp = me.get('access_exp'),
                            left = access_exp && (access_exp - now),
                            refresh_exp = me.get('refresh_exp'),
                            leftRe = (refresh_exp - now);
                        if (!refresh_exp || leftRe < 0) {
                            me.logoutAndWarn();
                        } else if (!access_exp || left < 0) {
                            return me.refresh()
                                .then(_.noop);
                        }
                    })
                    .catch(e => e && me.logoutAndWarn(e))
                    .then(function () {
                        me.checkRefStatus = false
                    });
            },
            login: function (creds) {
                var me = this;
                return new Promise(function (res, rej) {
                    me.loginModel.getAccess(creds)
                        .then(function (resp) {
                            me.parseResp(resp);
                            me.save();
                            me.getAuth().then(res).catch(rej);
                        })
                        .catch(rej);
                })
            },
            logout: function () {
                var me = this;
                return new Promise(function (res, rej) {
                    me.parseResp();
                    me.save();
                    res(!me.get('auth'));
                });
            },
            refresh: function () {
                var me = this;
                return new Promise(function (res, rej) {
                    const rt = me.get('refresh_token');
                    if (!rt) return rej('no token to refresh');
                    me.loginModel.getRefresh(rt)
                        .then(function (resp) {
                            me.parseResp(resp);
                            me.save();
                            me.getAuth().then(res).catch(rej);
                        })
                        .catch(rej);
                })
            },
            parseResp: function (resp) {
                if (typeof resp === 'string') {
                    try {
                        const json = JSON.parse(resp);
                        resp = json;
                    } catch (e) {

                    }
                }
                var me = this;
                var access_token = resp && resp['access_token'] && jwtDecode(resp['access_token']);
                var refresh_token = resp && resp['refresh_token'] && jwtDecode(resp['refresh_token']);
                if (resp && resp['access_token'] && access_token) {
                    const access_exp = moment.unix(access_token.exp).valueOf(),
                        refresh_exp = moment.unix(refresh_token.exp).valueOf();
                    me.set({
                        auth: true,
                        username: access_token['username'],
                        email: access_token['email'],
                        groups: access_token['groups'],
                        jug: access_token['jug'],

                        access_token: resp['access_token'],
                        access_exp: access_exp,

                        token_type: resp['token_type'],
                        expires_in: resp['expires_in'],

                        refresh_token: resp['refresh_token'],
                        refresh_exp: refresh_exp
                    });
                } else {
                    me.set({
                        auth: false,
                        username: '',
                        email: '',
                        groups: '',
                        jug: '',

                        access_token: '',
                        access_exp: '',

                        token_type: '',
                        expires_in: '',

                        refresh_token: '',
                        refresh_exp: ''
                    });
                }
            },
            getAuth: function () {
                var me = this;
                return new Promise(function (res, rej) {
                    me.get('auth') ? res() : rej();
                })
            }
        });
        return AuthModel;

    });
}());
