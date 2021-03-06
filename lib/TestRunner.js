/*
    coveraje - a simple javascript code coverage tool.

    TestRunner

    Copyright (c) 2011-2012 Wolfgang Kluge (klugesoftware.de, gehirnwindung.de)
*/

(function () {
    "use strict";

    var vm = require("vm"),
        CoverajeTimer = require("./TimerProxy"),
        CoverajeEvent = require("./EventEmitter"),
        isOwn = require("./utils").isOwn;

    function TestRunner(instance) {
        var option = instance.options;
        var shell = require("./shell").createShell(option);

        function setNewTimer(ctx) {
            var timer = new CoverajeTimer();

            ctx.setTimeout = timer.setTimeout;
            ctx.clearTimeout = timer.clearTimeout;
            ctx.setInterval = timer.clearTimeout;
            ctx.clearInterval = timer.clearTimeout;
            ctx[option.prefix + "stopTimers"] = timer.stopTimers;
        }

        function createContext() {
            /*jshint browser: true*/
            var context = vm.createContext();

            context[option.prefix + "runtime"] = instance.runtime;
            context.console = console;

            setNewTimer(context);

            var ctxs = option.globals.split(/\s+/g);
            var ctxl = ctxs.length;
            for (var i = 0; i < ctxl; i++) {
                var bshared = false;

                if (ctxs[i] === "browser") {
                    if (context.window == null) {
                        try {
                            context.window = require("jsdom").jsdom().createWindow();
                        } catch (ex1) {
                            shell.writeLine("");
                            shell.writeLine("***********************************************************");
                            shell.writeLine("* <color bright red>ERROR</color>: failed to load jsdom                             *");
                            shell.writeLine("* download it from                                        *");
                            shell.writeLine("* <color bright white>https://github.com/tmpvar/jsdom</color>                         *");
                            shell.writeLine("* it has some known problems on windows due to contextify *");
                            shell.writeLine("* write an issue if you need to run it on windows         *");
                            shell.writeLine("***********************************************************");
                        }
                    }
                    if (context.window && context.window.XMLHttpRequest == null) {
                        try {
                            context.window.XMLHttpRequest = require("xmlhttprequest");
                        } catch (ex2) {
                            shell.writeLine("");
                            shell.writeLine("***********************************************************");
                            shell.writeLine("* <color bright yellow>WARNING</color>: failed to load xmlhttprequest                  *");
                            shell.writeLine("* window.XMLHttpRequest == undefined                      *");
                            shell.writeLine("* if needed, download it from                             *");
                            shell.writeLine("* <color bright white>https://github.com/driverdan/node-XMLHttpRequest</color>        *");
                            shell.writeLine("***********************************************************");
                        }
                    }
                } else if (ctxs[i] === "node") {
                    /*jshint loopfunc: true*/
                    var Module = require("module");

                    if (context.global == null) context.global = global;
                    if (context.process == null) context.process = process;
                    if (context.__filename == null) {
                        var m = require("./core").entryModule();
                        if (m != null) {
                            context.__filename = m.filename + "$$cj";
                        } else {
                            context.__filename = process.mainModule.filename + "$$cj";
                        }
                    }
                    if (context.__dirname == null) context.__dirname = require("path").dirname(context.__filename);
                    if (context.module == null) {

                        context.module = Module._cache[context.__filename];
                        if (context.module == null) {
                            context.module = new Module(context.__filename, module);
                            context.module.filename = context.__filename;
                        }
                        if (context.module.exports == null) {
                            context.module.exports = {};
                        }
                        context.module.paths = Module._nodeModulePaths(context.__dirname);
                    }
                    if (context.exports == null) context.exports = context.module.exports;
                    if (context.require == null) {
                        context.require = function (path) {
                            return Module._load(path, context.module);
                        };
                    }
                }
            }
            return context;
        }

        function run(runner, key, context, event) {
            var ctx = context;

            function postRun() {
                // stop all timers now
                process.nextTick(function () {
                    ctx[option.prefix + "stopTimers"]();
                    event.complete(key, ctx);
                });
            }

            setNewTimer(ctx); // each run has its own timer

            var testEvent;

            shell.writeLine("run <color bright white>%s</color>", key || "");

            try {
                testEvent = runner(ctx, instance);
                if (ctx && ctx.module && ctx.module.loaded === false) {
                    ctx.module.loaded = true;
                }
            } catch (ex) {
                event.error(key, ex);
                postRun();
                return;
            }

            if (testEvent instanceof CoverajeEvent) {
                testEvent
                    .onComplete(postRun)
                    .onError(function (msg) {
                        event.error(key, msg);
                    })
                    .start();
            } else if (option.wait === 0) {
                postRun();
            } else {
                ctx.setTimeout(postRun, option.wait);
            }
        }

        function runMultiple(runner, context, event) {
            var runKeys = [], rk, rkl;
            var completed = [], errors = [];

            for (rk in runner) {
                if (isOwn(runner, rk) && typeof runner[rk] === "function") {
                    runKeys.push(rk);
                }
            }

            rkl = runKeys.length;
            if (rkl === 0) {
                event.complete("", context);
            } else if (rkl === 1) {
                rk = runKeys[0];
                run(runner[rk], rk, context, event);
            } else {
                var me = new CoverajeEvent();

                me
                    .onComplete(function (key) {
                        if (completed.indexOf(key) === -1) {
                            shell.write(".");
                            completed.push(key);
                        }

                        if (runKeys.length === completed.length) {
                            shell.writeLine(" complete");

                            for (var i = 0; i < errors.length; i++) {
                                event.error(errors[i].k, errors[i].m);
                            }
                            event.complete("", context);
                        }
                    })
                    .onError(function (key, msg) {
                        errors.push({k: key, m: msg});
                    });

                for (var i = 0; i < runKeys.length; i++) {
                    rk = runKeys[i];
                    run(runner[rk], rk, context, me);
                }
            }

        }

        //
        // run the injected code and one or all test runners
        // in their own context
        function runTest(code, runner) {
            /*jshint browser: true*/
            var event = new CoverajeEvent();

            event
                .onComplete(function () {
                    instance.complete(instance);
                })
                .onError(function (key, err) {
                    instance.error(key, err);
                })
                .onStart(function (key) {
                    instance.runtime.reset();

                    var context = createContext();
                    try {
                        var script = vm.createScript(code.codeToRun, "initial code");
                        script.runInContext(context);
                    } catch (ex2) {
                        event.error(key, ex2.stack ? ex2.stack : ex2);
                        return;
                    }

                    if (key != null && key !== "") {
                        runner = runner[key];
                        if (typeof runner !== "function") {
                            event.error(key, key + " is not a valid runner");
                            return;
                        }
                    }

                    if (runner == null) {
                        // set to complete, even if no runners are defined
                        event.complete();
                    } else {
                        try {
                            if (typeof runner === "function") {
                                run(runner, key, context, event);
                            } else if (runner != null) {
                                runMultiple(runner, context, event);
                            }
                        } catch (ex) {
                            event
                                .error(key, "error in test function\n" + (ex && ex.message ? ex.message : ex))
                                .complete();
                        }
                    }
                });

            return event;
        }

        return {
            runTest: runTest
        };
    }

    if (typeof module !== "undefined") {
        module.exports = TestRunner;
    }
}());
