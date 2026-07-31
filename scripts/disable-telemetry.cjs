"use strict";

const optOuts = {
  ASTRO_TELEMETRY_DISABLED: "1",
  ALCHEMY_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
};
const protectedKeys = new Set(Object.keys(optOuts));
const isProtectedKey = (key) => typeof key === "string" && protectedKeys.has(key.toUpperCase());

Object.assign(process.env, optOuts);

const environment = new Proxy(process.env, {
  set(target, key, value) {
    if (isProtectedKey(key)) return value === "1";
    return Reflect.set(target, key, value);
  },
  deleteProperty(target, key) {
    if (isProtectedKey(key)) return false;
    return Reflect.deleteProperty(target, key);
  },
  defineProperty(target, key, descriptor) {
    if (isProtectedKey(key)) return false;
    return Reflect.defineProperty(target, key, descriptor);
  },
});

Object.defineProperty(process, "env", {
  value: environment,
  writable: false,
  configurable: false,
  enumerable: true,
});
