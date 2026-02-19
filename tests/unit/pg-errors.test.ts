import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  config: {
    exposeDbErrors: false,
  },
}));

import { handleDbError } from "../../src/errors/pg-errors.js";
import { config } from "../../src/config.js";
import {
  makeUniqueViolation,
  makeFkViolation,
  makeNotNullViolation,
  makeInvalidInput,
  makeUnknownPgError,
} from "../fixtures/pg-errors.js";

function mockReply() {
  const reply: any = {
    status: vi.fn(),
    send: vi.fn(),
    request: { log: { error: vi.fn() } },
  };
  reply.status.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

describe("handleDbError", () => {
  beforeEach(() => {
    (config as any).exposeDbErrors = false;
  });

  it("maps 23505 (unique violation) to 409", () => {
    const reply = mockReply();
    handleDbError(makeUniqueViolation(), reply);
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Conflict" })
    );
  });

  it("maps 23503 (FK violation) to 400", () => {
    const reply = mockReply();
    handleDbError(makeFkViolation(), reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Foreign key violation" })
    );
  });

  it("maps 23502 (not null violation) to 400", () => {
    const reply = mockReply();
    handleDbError(makeNotNullViolation(), reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Not null violation" })
    );
  });

  it("maps 22P02 (invalid input) to 400", () => {
    const reply = mockReply();
    handleDbError(makeInvalidInput(), reply);
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Invalid input" })
    );
  });

  it("maps unknown PG error code to 500", () => {
    const reply = mockReply();
    handleDbError(makeUnknownPgError(), reply);
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Internal server error" })
    );
  });

  it("maps error without code to 500", () => {
    const reply = mockReply();
    handleDbError(new Error("some error"), reply);
    expect(reply.status).toHaveBeenCalledWith(500);
  });

  it("includes detail and constraint when exposeDbErrors is true", () => {
    (config as any).exposeDbErrors = true;
    const reply = mockReply();
    handleDbError(makeUniqueViolation("Key (email)=(a@b.com) exists"), reply);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "Key (email)=(a@b.com) exists",
        constraint: "users_email_key",
      })
    );
  });

  it("omits detail and constraint when exposeDbErrors is false", () => {
    const reply = mockReply();
    handleDbError(makeUniqueViolation(), reply);
    const sent = reply.send.mock.calls[0][0];
    expect(sent).not.toHaveProperty("detail");
    expect(sent).not.toHaveProperty("constraint");
  });

  it("logs the error for mapped PG errors", () => {
    const reply = mockReply();
    const err = makeUniqueViolation();
    handleDbError(err, reply);
    expect(reply.request.log.error).toHaveBeenCalledWith(err, "Database error");
  });

  it("logs the error for unhandled PG errors", () => {
    const reply = mockReply();
    const err = makeUnknownPgError();
    handleDbError(err, reply);
    expect(reply.request.log.error).toHaveBeenCalledWith(err, "Unhandled database error");
  });
});
