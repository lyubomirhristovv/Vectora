using System.ComponentModel.DataAnnotations.Schema;
using Vectora.Api.Helpers;

namespace Vectora.Api.Models;

public class ServiceBusConnection
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public required string ConnectionString { get; set; }
    [NotMapped]
    public bool IsEmulator => EmulatorAdmin.IsEmulatorConnectionString(ConnectionString);

    // Unexposed connections are invisible to MCP agents; McpAllowSend additionally permits sending.
    public bool McpExposed { get; set; }
    public bool McpAllowSend { get; set; }

    // User-defined display order (ascending). Ties broken by Name for stability.
    public int SortOrder { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}