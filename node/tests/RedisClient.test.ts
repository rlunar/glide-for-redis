import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "@jest/globals";
import { BufferReader, BufferWriter } from "protobufjs";
import RedisServer from "redis-server";
import { v4 as uuidv4 } from "uuid";
import {
    BaseClientConfiguration,
    ProtocolVersion,
    RedisClient,
    Transaction,
} from "../build-ts";
import { redis_request } from "../src/ProtobufMessage";
import { runBaseTests } from "./SharedTests";
import { flushallOnPort, transactionTest } from "./TestUtilities";
/* eslint-disable @typescript-eslint/no-var-requires */
const FreePort = require("find-free-port");

type Context = {
    client: RedisClient;
};

const PORT_NUMBER = 3000;

describe("RedisClient", () => {
    let server: RedisServer;
    let port: number;
    beforeAll(async () => {
        port = await FreePort(PORT_NUMBER).then(
            ([free_port]: number[]) => free_port
        );
        server = await new Promise((resolve, reject) => {
            const server = new RedisServer(port);
            server.open(async (err: Error | null) => {
                if (err) {
                    reject(err);
                }

                resolve(server);
            });
        });
    });

    afterEach(async () => {
        await flushallOnPort(port);
    });

    afterAll(() => {
        server.close();
    });

    const getAddress = (port: number) => {
        return [{ host: "localhost", port }];
    };

    const getOptions = (port: number): BaseClientConfiguration => {
        return {
            addresses: getAddress(port),
        };
    };

    it("test protobuf encode/decode delimited", () => {
        // This test is required in order to verify that the autogenerated protobuf
        // files has been corrected and the encoding/decoding works as expected.
        // See "Manually compile protobuf files" in node/README.md to get more info about the fix.
        const writer = new BufferWriter();
        const request = {
            callbackIdx: 1,
            singleCommand: {
                requestType: 2,
                argsArray: redis_request.Command.ArgsArray.create({
                    args: ["bar1", "bar2"],
                }),
            },
        };
        const request2 = {
            callbackIdx: 3,
            singleCommand: {
                requestType: 4,
                argsArray: redis_request.Command.ArgsArray.create({
                    args: ["bar3", "bar4"],
                }),
            },
        };
        redis_request.RedisRequest.encodeDelimited(request, writer);
        redis_request.RedisRequest.encodeDelimited(request2, writer);
        const buffer = writer.finish();
        const reader = new BufferReader(buffer);

        const dec_msg1 = redis_request.RedisRequest.decodeDelimited(reader);
        expect(dec_msg1.callbackIdx).toEqual(1);
        expect(dec_msg1.singleCommand?.requestType).toEqual(2);
        expect(dec_msg1.singleCommand?.argsArray?.args).toEqual([
            "bar1",
            "bar2",
        ]);

        const dec_msg2 = redis_request.RedisRequest.decodeDelimited(reader);
        expect(dec_msg2.callbackIdx).toEqual(3);
        expect(dec_msg2.singleCommand?.requestType).toEqual(4);
        expect(dec_msg2.singleCommand?.argsArray?.args).toEqual([
            "bar3",
            "bar4",
        ]);
    });

    it("info without parameters", async () => {
        const client = await RedisClient.createClient(getOptions(port));
        const result = await client.info();
        expect(result).toEqual(expect.stringContaining("# Server"));
        expect(result).toEqual(expect.stringContaining("# Replication"));
        expect(result).toEqual(expect.not.stringContaining("# Latencystats"));
        client.close();
    });

    it("simple select test", async () => {
        const client = await RedisClient.createClient(getOptions(port));
        let selectResult = await client.select(0);
        expect(selectResult).toEqual("OK");

        const key = uuidv4();
        const value = uuidv4();
        const result = await client.set(key, value);
        expect(result).toEqual("OK");

        selectResult = await client.select(1);
        expect(selectResult).toEqual("OK");
        expect(await client.get(key)).toEqual(null);

        selectResult = await client.select(0);
        expect(selectResult).toEqual("OK");
        expect(await client.get(key)).toEqual(value);
        client.close();
    });

    it.each([ProtocolVersion.RESP2, ProtocolVersion.RESP3])(
        `can send transactions_%p`,
        async () => {
            const client = await RedisClient.createClient(getOptions(port));
            const transaction = new Transaction();
            const expectedRes = transactionTest(transaction);
            transaction.select(0);
            const result = await client.exec(transaction);
            expectedRes.push("OK");
            expect(result).toEqual(expectedRes);
            client.close();
        }
    );

    it("can return null on WATCH transaction failures", async () => {
        const client1 = await RedisClient.createClient(getOptions(port));
        const client2 = await RedisClient.createClient(getOptions(port));
        const transaction = new Transaction();
        transaction.get("key");
        const result1 = await client1.customCommand(["WATCH", "key"]);
        expect(result1).toEqual("OK");

        const result2 = await client2.set("key", "foo");
        expect(result2).toEqual("OK");

        const result3 = await client1.exec(transaction);
        expect(result3).toBeNull();

        client1.close();
        client2.close();
    });

    runBaseTests<Context>({
        init: async (protocol?, clientName?) => {
            const options = getOptions(port);
            options.serverProtocol = protocol;
            options.clientName = clientName;
            const client = await RedisClient.createClient(options);

            return { client, context: { client } };
        },
        close: async (context: Context) => {
            context.client.close();
        },
    });
});
