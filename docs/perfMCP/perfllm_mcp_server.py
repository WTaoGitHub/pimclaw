#!/usr/bin/env python3.12
"""
MCP Server for PostgreSQL perfllm database
"""

import os

import psycopg2
from psycopg2.extras import RealDictCursor
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Database configuration
DB_CONFIG = {
    "host": os.environ.get("PERF_DB_HOST", "10.1.112.239"),
    "port": int(os.environ.get("PERF_DB_PORT", "34567")),
    "user": os.environ.get("PERF_DB_USER", "postgres"),
    "password": os.environ.get("PERF_DB_PASSWORD", "psql_admin123"),
    "database": os.environ.get("PERF_DB_NAME", "postgres"),
}

# Initialize the server
server = Server("perfllm-mcp-server")


def get_db_connection():
    """Create a database connection."""
    return psycopg2.connect(**DB_CONFIG)


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        Tool(
            name="query_perfllm",
            description="Query the perfllm table with optional filters. Returns LLM performance test data including model names, hardware config, latency metrics (TTFT, TPOT), throughput, and QPS.",
            inputSchema={
                "type": "object",
                "properties": {
                    "model_name": {
                        "type": "string",
                        "description": "Filter by model name (exact match, e.g. Qwen/Qwen3-235B-A22B)",
                    },
                    "scenario": {
                        "type": "string",
                        "description": "Filter by scenario name (exact match, e.g. vibe-coding)",
                    },
                    "engine_name": {
                        "type": "string",
                        "description": "Filter by engine name (exact match, e.g. vllm)",
                    },
                    "device_type": {
                        "type": "string",
                        "description": "Filter by device type (exact match, e.g. nvidia/h800)",
                    },
                    "node_num": {
                        "type": "integer",
                        "description": "Filter by number of nodes (exact match)",
                    },
                    "device_per_node": {
                        "type": "integer",
                        "description": "Filter by devices per node (exact match)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of rows to return (default: 10, max: 100)",
                        "default": 10,
                    },
                },
            },
        ),
        Tool(
            name="get_perfllm_schema",
            description="Get the schema/structure of the perfllm table",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle tool calls."""
    if name == "query_perfllm":
        return await query_perfllm(arguments)
    elif name == "get_perfllm_schema":
        return await get_perfllm_schema()
    else:
        raise ValueError(f"Unknown tool: {name}")


async def query_perfllm(args: dict) -> list[TextContent]:
    """Query perfllm table with filters."""
    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            conditions = []
            params = []

            if args.get("model_name"):
                conditions.append("model_name = %s")
                params.append(args["model_name"])

            if args.get("scenario"):
                conditions.append("scenario = %s")
                params.append(args["scenario"])

            if args.get("engine_name"):
                conditions.append("engine_name = %s")
                params.append(args["engine_name"])

            if args.get("device_type"):
                conditions.append("device_type = %s")
                params.append(args["device_type"])

            if args.get("node_num") is not None:
                conditions.append("node_num = %s")
                params.append(args["node_num"])

            if args.get("device_per_node") is not None:
                conditions.append("device_per_node = %s")
                params.append(args["device_per_node"])

            where_clause = " AND ".join(conditions) if conditions else "1=1"
            limit = min(args.get("limit", 10), 100)
            query = f"""
                SELECT id, model_name, engine_name, device_type, node_num,
                       device_per_node, scenario, dtype, quantization,
                       gpu_memory_utilization, data_parallel_size,
                       pipeline_parallel_size, tensor_parallel_size,
                       enable_expert_parallel, enable_chunked_prefill,
                       ttft, tpot, qps, throughput, max_model_len,
                       concurrency_when_max_len, max_num_seqs,
                       container_image, task_id, cpu, memory
                FROM public.perfllm
                WHERE {where_clause}
                ORDER BY id DESC
                LIMIT {limit}
            """

            cur.execute(query, params)
            rows = cur.fetchall()

            if not rows:
                return [TextContent(type="text", text="No results found.")]

            result = "## perfllm Query Results\n\n"
            result += f"Found {len(rows)} row(s):\n\n"

            for row in rows:
                result += "### Entry\n"
                for key, value in row.items():
                    if value is not None:
                        result += f"- **{key}**: {value}\n"
                result += "\n"

            return [TextContent(type="text", text=result)]
    finally:
        conn.close()


async def get_perfllm_schema() -> list[TextContent]:
    """Get the schema of perfllm table."""
    conn = get_db_connection()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT column_name, data_type, is_nullable
                FROM information_schema.columns
                WHERE table_name = 'perfllm' AND table_schema = 'public'
                ORDER BY ordinal_position
            """)
            columns = cur.fetchall()

            result = "## perfllm Table Schema\n\n"
            result += "| Column | Type | Nullable |\n"
            result += "|--------|------|----------|\n"
            for col in columns:
                result += f"| {col['column_name']} | {col['data_type']} | {col['is_nullable']} |\n"

            return [TextContent(type="text", text=result)]
    finally:
        conn.close()


async def main():
    """Run the MCP server."""
    import sys
    print("perfllm MCP server starting...", file=sys.stderr)
    print(
        "Database:",
        f"{DB_CONFIG['host']}:{DB_CONFIG['port']}",
        "/",
        DB_CONFIG["database"],
        file=sys.stderr,
    )
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
