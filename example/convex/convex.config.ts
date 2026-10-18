import { defineApp } from "convex/server";
import convexFlows from "../../src/component/convex.config.js";

const app = defineApp();
app.use(convexFlows);

export default app;
