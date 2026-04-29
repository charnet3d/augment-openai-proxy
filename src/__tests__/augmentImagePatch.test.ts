import { describe, it, expect, vi } from "vitest";
import {
  mediaTypeToFormat,
  dataToBase64,
  hasAnyImage,
  buildChatRequestWithImages,
  patchModelForImages,
} from "../services/augmentImagePatch";

describe("augmentImagePatch", () => {
  describe("mediaTypeToFormat", () => {
    it("maps known image media types to Augment format integers", () => {
      expect(mediaTypeToFormat("image/png")).toBe(1);
      expect(mediaTypeToFormat("image/jpeg")).toBe(2);
      expect(mediaTypeToFormat("image/jpg")).toBe(2);
      expect(mediaTypeToFormat("image/gif")).toBe(3);
      expect(mediaTypeToFormat("image/webp")).toBe(4);
    });

    it("falls back to PNG (1) for unknown / missing types", () => {
      expect(mediaTypeToFormat(undefined)).toBe(1);
      expect(mediaTypeToFormat("")).toBe(1);
      expect(mediaTypeToFormat("application/octet-stream")).toBe(1);
    });

    it("strips parameters and is case-insensitive", () => {
      expect(mediaTypeToFormat("Image/JPEG; charset=binary")).toBe(2);
    });
  });

  describe("dataToBase64", () => {
    it("returns string data unchanged (assumed already base64)", () => {
      expect(dataToBase64("aGVsbG8=")).toBe("aGVsbG8=");
    });

    it("encodes Uint8Array to base64", () => {
      expect(dataToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    });

    it("encodes ArrayBuffer to base64", () => {
      const buf = new Uint8Array([104, 105]).buffer;
      expect(dataToBase64(buf)).toBe("aGk=");
    });

    it("returns null for URL or unsupported data", () => {
      expect(dataToBase64(new URL("https://example.com/x.png"))).toBeNull();
      expect(dataToBase64(null)).toBeNull();
      expect(dataToBase64(undefined)).toBeNull();
      expect(dataToBase64(123)).toBeNull();
    });
  });

  describe("hasAnyImage", () => {
    it("detects image file parts in user messages", () => {
      expect(
        hasAnyImage([
          { role: "user", content: [{ type: "file", data: "x", mediaType: "image/png" }] },
        ]),
      ).toBe(true);
    });

    it("ignores non-image file parts and text-only prompts", () => {
      expect(hasAnyImage([{ role: "user", content: "hi" }])).toBe(false);
      expect(
        hasAnyImage([
          { role: "user", content: [{ type: "file", data: "x", mediaType: "application/pdf" }] },
        ]),
      ).toBe(false);
      expect(hasAnyImage(undefined)).toBe(false);
    });
  });

  describe("buildChatRequestWithImages", () => {
    it("emits IMAGE nodes (type 2) with image_node payload for image file parts", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
            ],
          },
        ],
        undefined,
      );
      expect(out.nodes).toHaveLength(2);
      expect(out.nodes[0]).toMatchObject({ id: 0, type: 0, text_node: { content: "What is this?" } });
      expect(out.nodes[1]).toMatchObject({
        id: 1,
        type: 2,
        image_node: { image_data: "AQID", format: 2 },
      });
      expect(out.message).toBe("What is this?");
      expect(out.chatHistory).toHaveLength(0);
    });

    it("skips file parts whose data can't be inlined (e.g. URL)", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "file", data: new URL("https://example.com/x.png"), mediaType: "image/png" },
            ],
          },
        ],
        undefined,
      );
      expect(out.nodes).toHaveLength(1);
      expect(out.nodes[0].type).toBe(0);
    });

    it("places images from previous user turns into chat_history.request_nodes", () => {
      const out = buildChatRequestWithImages(
        [
          {
            role: "user",
            content: [{ type: "file", data: "AAAA", mediaType: "image/webp" }],
          },
          { role: "assistant", content: "ok" },
          { role: "user", content: [{ type: "text", text: "follow up" }] },
        ],
        undefined,
      );
      expect(out.chatHistory).toHaveLength(1);
      const histNodes = out.chatHistory[0].request_nodes;
      const imgNode = histNodes.find((n: any) => n.type === 2);
      expect(imgNode).toBeDefined();
      expect(imgNode.image_node).toEqual({ image_data: "AAAA", format: 4 });
      expect(out.nodes).toHaveLength(1);
      expect(out.nodes[0].type).toBe(0);
    });

    it("converts function tool definitions to Augment shape", () => {
      const out = buildChatRequestWithImages(
        [{ role: "user", content: [{ type: "file", data: "x", mediaType: "image/png" }] }],
        [{ type: "function", name: "get_weather", description: "d", inputSchema: { type: "object" } }],
      );
      expect(out.toolDefinitions).toEqual([
        { name: "get_weather", description: "d", input_schema_json: '{"type":"object"}' },
      ]);
    });
  });

  describe("patchModelForImages", () => {
    it("delegates to original buildPayload when prompt has no images", () => {
      const original = vi.fn().mockReturnValue({ original: true });
      const model: any = { buildPayload: original, modelId: "m", sessionId: "s" };
      patchModelForImages(model);
      const result = model.buildPayload({ prompt: [{ role: "user", content: "hi" }] });
      expect(original).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ original: true });
      expect(model.supportsImageUrls).toBe(true);
    });

    it("builds an image-aware payload when an image is present", () => {
      const original = vi.fn();
      const model: any = { buildPayload: original, modelId: "claude-x", sessionId: "sess" };
      patchModelForImages(model);
      const payload = model.buildPayload({
        prompt: [
          {
            role: "user",
            content: [{ type: "file", data: "Zm9v", mediaType: "image/png" }],
          },
        ],
      });
      expect(original).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        mode: "CLI_AGENT",
        model: "claude-x",
        conversation_id: "sess",
      });
      expect(payload.nodes[0]).toMatchObject({
        type: 2,
        image_node: { image_data: "Zm9v", format: 1 },
      });
    });

    it("is a no-op when the model has no buildPayload (defensive)", () => {
      const model: any = { modelId: "m" };
      expect(() => patchModelForImages(model)).not.toThrow();
      expect(model.buildPayload).toBeUndefined();
    });
  });
});
