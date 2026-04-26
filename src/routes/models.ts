import { Hono } from "hono";
import { listModels } from "../services/modelRegistry";

const router = new Hono();

router.get("/", (c) => {
  return c.json(listModels());
});

export default router;
