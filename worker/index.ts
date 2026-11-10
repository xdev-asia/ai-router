import { makeApp } from "./app";

export default makeApp({ upstream: (req) => fetch(req) });
