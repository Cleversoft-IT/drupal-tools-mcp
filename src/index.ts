#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as cheerio from "cheerio";
import { Element } from "domhandler";

interface DrushCommand {
    name: string;
    description: string;
    usage?: string;
    arguments?: Array<{
        name: string;
        description: string;
        required: boolean;
    }>;
    options?: Array<{
        name: string;
        description: string;
    }>;
    examples?: string[];
    aliases?: string[];
    url: string;
}

class DrushCommandsServer {
    private server: Server;
    private baseUrl: string = "";

    constructor() {
        this.server = new Server(
            {
                name: "drush-commands-mcp",
                version: "0.1.0",
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.setupToolHandlers();

        this.server.onerror = (error) => console.error("[MCP Error]", error);
        process.on("SIGINT", async () => {
            await this.server.close();
            process.exit(0);
        });
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "get_command_info",
                    description:
                        "Get detailed information about a specific Drush command",
                    inputSchema: {
                        type: "object",
                        properties: {
                            command_name: {
                                type: "string",
                                description: "Name of the Drush command",
                            },
                            version: {
                                type: "string",
                                description:
                                    "Drush version (e.g. '13.x'). Defaults to '13.x'",
                            },
                        },
                        required: ["command_name"],
                    },
                },
            ],
        }));

        this.server.setRequestHandler(
            CallToolRequestSchema,
            async (request) => {
                const version =
                    (request.params.arguments as any)?.version || "13.x";
                this.baseUrl = `https://www.drush.org/${version}/commands`;

                switch (request.params.name) {
                    case "get_command_info":
                        const args = request.params.arguments as {
                            command_name: string;
                            version?: string;
                        };
                        if (!args.command_name) {
                            throw new McpError(
                                ErrorCode.InvalidParams,
                                "Command name is required"
                            );
                        }

                        try {
                            const commandInfo = await this.fetchCommandInfo(
                                args.command_name
                            );
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: JSON.stringify(
                                            commandInfo,
                                            null,
                                            2
                                        ),
                                    },
                                ],
                            };
                        } catch (error) {
                            if (axios.isAxiosError(error)) {
                                throw new McpError(
                                    ErrorCode.InternalError,
                                    `Failed to fetch command info: ${error.message}`
                                );
                            }
                            throw error;
                        }

                    default:
                        throw new McpError(
                            ErrorCode.MethodNotFound,
                            `Unknown tool: ${request.params.name}`
                        );
                }
            }
        );
    }

    private async fetchCommandInfo(commandName: string): Promise<DrushCommand> {
        const url = `${this.baseUrl}/${commandName}/`;
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);

        // Get the main content div
        const $content = $("article.md-content__inner");

        // Get description (first paragraph after h1)
        const description = $content.find("h1 + p").text().trim();

        // Helper function to extract section content
        const extractSection = (title: string): cheerio.Cheerio<Element> => {
            const $section = $content
                .find(`h4[id="${title.toLowerCase()}"]`)
                .next("ul");
            return $section.length ? $section : cheerio.load("")("ul");
        };

        // Helper function to process description
        const processDescription = (desc: string): string => {
            // Convert HTML to plain text
            desc = desc.replace(/<\/?[^>]+(>|$)/g, "");
            // Remove leading/trailing periods and spaces
            desc = desc.replace(/^\.?\s*/, "").replace(/\.\s*$/, "");
            // Add note about multiple values if description contains ellipsis
            if (desc.includes("...")) {
                desc += " (accepts multiple values)";
            }
            // Extract default value if present
            const defaultMatch = desc.match(/\(defaults?\s+to\s+([^)]+)\)/i);
            if (defaultMatch) {
                const defaultValue = defaultMatch[1].trim();
                // Move default value to end if it's not already there
                if (!desc.endsWith(defaultMatch[0])) {
                    desc =
                        desc.replace(defaultMatch[0], "") +
                        ` (defaults to ${defaultValue})`;
                }
            }
            // Add period at the end if missing
            if (!desc.endsWith(")") && !desc.endsWith(".")) {
                desc += ".";
            }
            return desc;
        };

        // Parse arguments section
        const args: DrushCommand["arguments"] = [];
        const $argsSection = extractSection("Arguments");
        if ($argsSection.length) {
            $argsSection.find("li").each((index: number, li: Element) => {
                // Get the raw HTML and extract argument name and description
                const html = $(li).html() || "";
                const strongMatch = html.match(
                    /<strong>\[?([^\]]+?)\]?<\/strong>\s*(.*)/
                );
                if (strongMatch) {
                    const name = strongMatch[1].replace(/\.$/, "");
                    const description = processDescription(strongMatch[2]);
                    args.push({
                        name,
                        description,
                        required: !html.includes("["),
                    });
                }
            });
        }

        // Parse options section
        const options: DrushCommand["options"] = [];
        const $optionsSection = extractSection("Options");
        if ($optionsSection.length) {
            $optionsSection.find("li").each((index: number, li: Element) => {
                const text = $(li).text().trim();
                // Match option name and description
                const match = text.match(
                    /^\*\*\s+--([a-zA-Z0-9-]+)(?:=[^*]+)?\*\*\.?\s*(.*)$/
                );
                if (match) {
                    options.push({
                        name: match[1],
                        description: processDescription(match[2]),
                    });
                }
            });
        }

        // Parse examples section
        const examples: string[] = [];
        const $examplesSection = extractSection("Examples");
        if ($examplesSection.length) {
            $examplesSection.find("li").each((index: number, li: Element) => {
                const text = $(li).text().trim();
                if (text) {
                    examples.push(text);
                }
            });
        }

        // Parse aliases section
        const aliases: string[] = [];
        const $aliasesSection = extractSection("Aliases");
        if ($aliasesSection.length) {
            $aliasesSection.find("li").each((index: number, li: Element) => {
                const text = $(li).text().trim();
                if (text) {
                    aliases.push(text);
                }
            });
        }

        return {
            name: commandName,
            description,
            arguments: args,
            options,
            examples,
            aliases,
            url,
        };
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Drush Commands MCP server running on stdio");
    }
}

const server = new DrushCommandsServer();
server.run().catch(console.error);
