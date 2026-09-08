using Microsoft.EntityFrameworkCore;
using Vectora.Api.Data;
using Vectora.Api.Helpers;
using Vectora.Api.Models;

namespace Vectora.Api.Repositories;

public class ConnectionRepository : IConnectionRepository
{
    private readonly VectoraDbContext _db;
    private readonly IServiceBusClientCache _clientCache;
    private readonly IServiceBusEntityCache _entityCache;

    public ConnectionRepository(VectoraDbContext db, IServiceBusClientCache clientCache, IServiceBusEntityCache entityCache)
    {
        _db = db;
        _clientCache = clientCache;
        _entityCache = entityCache;
    }

    public async Task<List<ServiceBusConnection>> GetAllAsync()
    {
        return await _db.Connections
            .OrderBy(c => c.SortOrder)
            .ThenBy(c => c.Name)
            .ToListAsync();
    }

    public async Task<ServiceBusConnection?> GetByIdAsync(int id)
    {
        return await _db.Connections.FindAsync(id);
    }

    public async Task<ServiceBusConnection> CreateAsync(string name, string connectionString)
    {
        // Append new connections at the end of the current ordering.
        var maxSortOrder = await _db.Connections.AnyAsync()
            ? await _db.Connections.MaxAsync(c => c.SortOrder)
            : -1;

        var connection = new ServiceBusConnection
        {
            Name = name,
            ConnectionString = connectionString,
            IsEmulator = EmulatorAdmin.IsEmulatorConnectionString(connectionString),
            SortOrder = maxSortOrder + 1
        };
        _db.Connections.Add(connection);
        await _db.SaveChangesAsync();
        return connection;
    }

    public async Task<ServiceBusConnection?> UpdateAsync(int id, string name, string? connectionString)
    {
        var connection = await _db.Connections.FindAsync(id);
        if (connection == null)
        {
            return null;
        }

        connection.Name = name;
        // Only re-derive when the string actually changes: a rename must not flip the mode of a
        // connection saved before emulator detection existed.
        if (!string.IsNullOrEmpty(connectionString) && connectionString != connection.ConnectionString)
        {
            connection.ConnectionString = connectionString;
            connection.IsEmulator = EmulatorAdmin.IsEmulatorConnectionString(connectionString);
        }
        connection.UpdatedAt = DateTime.UtcNow;

        await _db.SaveChangesAsync();

        // Invalidate cached clients and entities for this connection
        _clientCache.InvalidateConnection(id);
        _entityCache.Invalidate(id);

        return connection;
    }

    public async Task<ServiceBusConnection?> UpdateMcpFlagsAsync(int id, bool mcpExposed, bool mcpAllowSend)
    {
        var connection = await _db.Connections.FindAsync(id);
        if (connection == null)
        {
            return null;
        }

        connection.McpExposed = mcpExposed;
        // Sending requires exposure; clamp so "allow send" can't linger on a hidden connection.
        connection.McpAllowSend = mcpExposed && mcpAllowSend;

        await _db.SaveChangesAsync();
        return connection;
    }

    public async Task ReorderAsync(IReadOnlyList<int> orderedIds)
    {
        var connections = await _db.Connections.ToDictionaryAsync(c => c.Id);
        for (var i = 0; i < orderedIds.Count; i++)
        {
            if (connections.TryGetValue(orderedIds[i], out var connection))
            {
                connection.SortOrder = i;
            }
        }
        await _db.SaveChangesAsync();
    }

    public async Task<bool> DeleteAsync(int id)
    {
        var connection = await _db.Connections.FindAsync(id);
        if (connection == null)
        {
            return false;
        }
        _db.Connections.Remove(connection);
        await _db.SaveChangesAsync();

        // Invalidate cached clients and entities for this connection
        _clientCache.InvalidateConnection(id);
        _entityCache.Invalidate(id);

        return true;
    }
}
