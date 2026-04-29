import { Hono } from "hono";
import { listModels } from "../services/modelRegistry";

const router = new Hono();

router.get("/", async (c) => {
  return c.json(await listModels());
});

export default router;
