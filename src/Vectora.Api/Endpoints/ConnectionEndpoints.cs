using Vectora.Api.Helpers;
using Vectora.Api.Models;
using Vectora.Api.Repositories;

namespace Vectora.Api.Endpoints;

public static class ConnectionEndpoints
{
    public static void MapConnectionEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/connections").WithTags("Connections");

        group.MapGet("/", GetAll)
            .WithName("GetAllConnections");

        group.MapGet("/{id:int}", GetById)
            .WithName("GetConnectionById");

        group.MapPost("/", Create)
            .WithName("CreateConnection");

        group.MapPut("/{id:int}", Update)
            .WithName("UpdateConnection");

        group.MapDelete("/{id:int}", Delete)
            .WithName("DeleteConnection");

        group.MapPut("/{id:int}/mcp", UpdateMcpFlags)
            .WithName("UpdateConnectionMcpFlags");

        group.MapPut("/reorder", Reorder)
            .WithName("ReorderConnections");
    }

    private static async Task<IResult> GetAll(IConnectionRepository connectionRepository)
    {
        var connections = await connectionRepository.GetAllAsync();
        var dtos = connections.Select(ToDto).ToList();
        return Results.Ok(dtos);
    }

    private static async Task<IResult> GetById(int id, IConnectionRepository connectionRepository)
    {
        var connection = await connectionRepository.GetByIdAsync(id);
        if (connection == null)
        {
            return Results.NotFound();
        }

        return Results.Ok(ToDto(connection));
    }

    private static async Task<IResult> Create(CreateConnectionDto dto, IConnectionRepository connectionRepository)
    {
        // Validate input
        var (nameValid, nameError) = ValidationHelper.ValidateConnectionName(dto.Name);
        if (!nameValid)
        {
            return Results.BadRequest(new { error = nameError });
        }

        var (connValid, connError) = ValidationHelper.ValidateConnectionString(dto.ConnectionString);
        if (!connValid)
        {
            return Results.BadRequest(new { error = connError });
        }

        var connection = await connectionRepository.CreateAsync(dto.Name, dto.ConnectionString);
        return Results.Created($"/api/connections/{connection.Id}", ToDto(connection));
    }

    private static async Task<IResult> Update(int id, UpdateConnectionDto dto, IConnectionRepository connectionRepository)
    {
        // Validate input
        var (nameValid, nameError) = ValidationHelper.ValidateConnectionName(dto.Name);
        if (!nameValid)
        {
            return Results.BadRequest(new { error = nameError });
        }

        if (!string.IsNullOrEmpty(dto.ConnectionString))
        {
            var (connValid, connError) = ValidationHelper.ValidateConnectionString(dto.ConnectionString);
            if (!connValid)
            {
                return Results.BadRequest(new { error = connError });
            }
        }

        var connection = await connectionRepository.UpdateAsync(id, dto.Name, dto.ConnectionString);
        if (connection == null)
        {
            return Results.NotFound();
        }

        return Results.Ok(ToDto(connection));
    }

    private static async Task<IResult> Delete(int id, IConnectionRepository connectionRepository)
    {
        var deleted = await connectionRepository.DeleteAsync(id);
        if (!deleted)
        {
            return Results.NotFound();
        }

        return Results.NoContent();
    }

    private static async Task<IResult> UpdateMcpFlags(int id, UpdateMcpFlagsDto dto, IConnectionRepository connectionRepository)
    {
        var connection = await connectionRepository.UpdateMcpFlagsAsync(id, dto.McpExposed, dto.McpAllowSend);
        if (connection == null)
        {
            return Results.NotFound();
        }

        return Results.Ok(ToDto(connection));
    }

    private static async Task<IResult> Reorder(ReorderConnectionsDto dto, IConnectionRepository connectionRepository)
    {
        if (dto.OrderedIds == null || dto.OrderedIds.Count == 0)
        {
            return Results.BadRequest(new { error = "orderedIds is required" });
        }

        await connectionRepository.ReorderAsync(dto.OrderedIds);
        return Results.NoContent();
    }

    private static ConnectionDto ToDto(ServiceBusConnection c) => new()
    {
        Id = c.Id,
        Name = c.Name,
        ConnectionString = c.ConnectionString,
        IsEmulator = c.IsEmulator,
        McpExposed = c.McpExposed,
        McpAllowSend = c.McpAllowSend,
        SortOrder = c.SortOrder
    };
}
