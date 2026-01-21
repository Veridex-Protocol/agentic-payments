/**
 * @packageDocumentation
 * @module MCPTypes
 * @description
 * Type definitions for the Model Context Protocol (MCP).
 * 
 * Defines the structure of Tools exposed to Large Language Models.
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
  handler: (params: any) => Promise<any>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}
