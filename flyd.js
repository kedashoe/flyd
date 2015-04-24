(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory); // AMD. Register as an anonymous module.
  } else if (typeof exports === 'object') {
    module.exports = factory(); // NodeJS
  } else { // Browser globals (root is window)
    root.flyd = factory();
  }
}(this, function () {

'use strict';

function isFunction(obj) {
  return !!(obj && obj.constructor && obj.call && obj.apply);
}

function isUndefined(v) {
  return v === undefined;
}

var toUpdate = [];
var inStream;

function removeListener(listeners, s) {
  var idx = listeners.indexOf(s);
  listeners[idx] = listeners[listeners.length - 1];
  listeners.length--;
}

function map(s, f) {
  return stream([s], function() { return f(s()); });
}

var scan = curryN(3, function(f, acc, s) {
  var ns = stream([s], function() {
    return (acc = f(acc, s()));
  });
  if (!ns.hasVal) ns(acc);
  return ns;
});

var merge = curryN(2, function(s1, s2) {
  var s = stream([s1, s2], function(n, changed) {
    return changed[0] ? changed[0]()
         : s1.hasVal  ? s1()
                      : s2();
  }, true);
  endsOn(stream([s1.end, s2.end], function(self, changed) {
    return true;
  }), s);
  return s;
});

function ap(s2) {
  var s1 = this;
  return stream([s1, s2], function() { return s1()(s2()); });
}

function of(v) {
  return stream(v);
}

function initialDepsNotMet(stream) {
  if (!stream.depsMet) {
    stream.depsMet = stream.deps.every(function(s) {
      return s.hasVal;
    });
  }
  return !stream.depsMet;
}

function updateStream(s) {
  if (initialDepsNotMet(s) || s.ended) return;
  inStream = s;
  var returnVal = s.fn(s, s.depsChanged);
  if (returnVal !== undefined) {
    s(returnVal);
  }
  inStream = undefined;
  s.depsChanged = [];
}

function findDeps(order, s) {
  if (!s.queued) {
    s.queued = true;
    for (var i = 0; i < s.listeners.length; ++i) {
      findDeps(order, s.listeners[i]);
    }
    order.push(s);
  }
}

function updateDeps(s) {
  var i, order = [];
  for (i = 0; i < s.listeners.length; ++i) {
    if (s.listeners[i].end === s) {
      end(s.listeners[i]);
    } else {
      s.listeners[i].depsChanged.push(s);
      findDeps(order, s.listeners[i]);
    }
  }
  for (i = order.length - 1; i >= 0; --i) {
    if (order[i].depsChanged.length > 0) {
      updateStream(order[i]);
    }
    order[i].queued = false;
  }
}

function flushUpdate() {
  for (var s; s = toUpdate.shift();) {
    updateDeps(s);
  }
}

function end(s) {
  s.ended = true;
  if (s.deps) s.deps.forEach(function(dep) { removeListener(dep.listeners, s); });
}

function endsOn(endS, s) {
  if (s.end) {
    removeListener(s.end.listeners, s);
    if (isUndefined(s.end.end)) end(s.end);
  }
  s.end = endS;
  endS.listeners.push(s);
  return s;
}

function isStream(stream) {
  return isFunction(stream) && 'hasVal' in stream;
}

function streamToString() {
  return 'stream(' + this.val + ')';
}

function createStream() {
  function s(n) {
    if (arguments.length > 0) {
      if (n && isFunction(n.then)) {
        n.then(s);
        return;
      }
      s.val = n;
      s.hasVal = true;
      if (inStream !== s) {
        toUpdate.push(s);
        if (!inStream) flushUpdate();
      } else {
        for (var j = 0; j < s.listeners.length; ++j) {
          if (s.listeners[j].end === s) {
            end(s.listeners[j]);
          } else {
            s.listeners[j].depsChanged.push(s);
          }
        }
      }
      return s;
    } else {
      return s.val;
    }
  }
  s.hasVal = false;
  s.val = undefined;
  s.listeners = [];
  s.queued = false;
  s.end = undefined;
  s.ended = false;

  s.map = map.bind(null, s);
  s.ap = ap;
  s.of = of;
  s.toString = streamToString;

  return s;
}

function createDependentStream(deps, fn, dontWaitForDeps) {
  var s = createStream();
  s.fn = fn;
  s.deps = deps;
  s.depsMet = dontWaitForDeps;
  s.depsChanged = [];
  deps.forEach(function(dep) {
    dep.listeners.push(s);
  });
  return s;
}

function stream(arg, fn, dontWaitForDeps) {
  var s;
  if (arguments.length > 1) {
    s = createDependentStream(arg, fn, isUndefined(dontWaitForDeps) ? false : true);
    var depEndStreams = arg.filter(function(d) { return !isUndefined(d.end); })
                           .map(function(d) { return d.end; });
    endsOn(createDependentStream(depEndStreams, function() { return true; }, true), s);
    updateStream(s);
    flushUpdate();
  } else {
    s = createStream();
    endsOn(createStream(), s);
    if (arguments.length === 1) s(arg);
  }
  return s;
}

var transduce = curryN(2, function(xform, source) {
  xform = xform(new StreamTransformer(stream));
  return stream([source], function() {
    return xform.step(undefined, source());
  });
});

function StreamTransformer(res) { }
StreamTransformer.prototype.init = function() { };
StreamTransformer.prototype.result = function() { };
StreamTransformer.prototype.step = function(s, v) { return v; };

// Own curry implementation snatched from Ramda
// Figure out something nicer later on
var _ = {placeholder: true};

// Detect both own and Ramda placeholder
function isPlaceholder(p) {
  return p === _ || (p && p.ramda === 'placeholder');
}

function toArray(arg) {
  var arr = [];
  for (var i = 0; i < arg.length; ++i) {
    arr[i] = arg[i];
  }
  return arr;
}

// Modified versions of arity and curryN from Ramda
function ofArity(n, fn) {
  if (arguments.length === 1) {
    return ofArity.bind(undefined, n);
  }
  switch (n) {
  case 0:
    return function () {
      return fn.apply(this, arguments);
    };
  case 1:
    return function (a0) {
      void a0;
      return fn.apply(this, arguments);
    };
  case 2:
    return function (a0, a1) {
      void a1;
      return fn.apply(this, arguments);
    };
  case 3:
    return function (a0, a1, a2) {
      void a2;
      return fn.apply(this, arguments);
    };
  case 4:
    return function (a0, a1, a2, a3) {
      void a3;
      return fn.apply(this, arguments);
    };
  case 5:
    return function (a0, a1, a2, a3, a4) {
      void a4;
      return fn.apply(this, arguments);
    };
  case 6:
    return function (a0, a1, a2, a3, a4, a5) {
      void a5;
      return fn.apply(this, arguments);
    };
  case 7:
    return function (a0, a1, a2, a3, a4, a5, a6) {
      void a6;
      return fn.apply(this, arguments);
    };
  case 8:
    return function (a0, a1, a2, a3, a4, a5, a6, a7) {
      void a7;
      return fn.apply(this, arguments);
    };
  case 9:
    return function (a0, a1, a2, a3, a4, a5, a6, a7, a8) {
      void a8;
      return fn.apply(this, arguments);
    };
  case 10:
    return function (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) {
      void a9;
      return fn.apply(this, arguments);
    };
  default:
    throw new Error('First argument to arity must be a non-negative integer no greater than ten');
  }
}

function curryN(length, fn) {
  return ofArity(length, function () {
    var n = arguments.length;
    var shortfall = length - n;
    var idx = n;
    while (--idx >= 0) {
      if (isPlaceholder(arguments[idx])) {
        shortfall += 1;
      }
    }
    if (shortfall <= 0) {
      return fn.apply(this, arguments);
    } else {
      var initialArgs = toArray(arguments);
      return curryN(shortfall, function () {
        var currentArgs = toArray(arguments);
        var combinedArgs = [];
        var idx = -1;
        while (++idx < n) {
          var val = initialArgs[idx];
          combinedArgs[idx] = isPlaceholder(val) ? currentArgs.shift() : val;
        }
        return fn.apply(this, combinedArgs.concat(currentArgs));
      });
    }
  });
}


return {
  stream: stream,
  isStream: isStream,
  transduce: transduce,
  merge: merge,
  reduce: scan, // Legacy
  scan: scan,
  endsOn: endsOn,
  map: curryN(2, function(f, s) { return map(s, f); }),
  curryN: curryN,
  _: _,
};

}));
