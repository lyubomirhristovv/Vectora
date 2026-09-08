namespace Vectora.Api.Models;

public class ServiceBusConnection
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public required string ConnectionString { get; set; }

    // Derived from the connection string whenever one is saved (see ConnectionRepository), not set
    // by the user. Stored rather than computed so a connection saved before emulator detection
    // existed keeps the mode it was given.
    public bool IsEmulator { get; set; }

    // Unexposed connections are invisible to MCP agents; McpAllowSend additionally permits sending.
    public bool McpExposed { get; set; }
    public bool McpAllowSend { get; set; }

    // User-defined display order (ascending). Ties broken by Name for stability.
    public int SortOrder { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}