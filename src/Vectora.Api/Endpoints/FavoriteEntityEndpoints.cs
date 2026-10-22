using Vectora.Api.Models;
using Vectora.Api.Repositories;
using Vectora.Api.Services;

namespace Vectora.Api.Endpoints;

public static class FavoriteEntityEndpoints
{
    private const int MaxNameLength = 260;
    private static readonly HashSet<string> EntityTypes = ["queue", "topic", "subscription"];

    public static void MapFavoriteEntityEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/connections/{connectionId:int}/favorites").WithTags("Favorites");

        group.MapGet("/", GetAll)
            .WithName("GetFavoriteEntities");

        group.MapPut("/", Add)
            .WithName("AddFavoriteEntity");

        group.MapDelete("/", Remove)
            .WithName("RemoveFavoriteEntity");
    }

    private static async Task<IResult> GetAll(int connectionId, IConnectionRepository connections, IFavoriteEntityService service)
    {
        if (await connections.GetByIdAsync(connectionId) == null)
        {
            return Results.NotFound(new { error = "Connection not found" });
        }

        var favorites = await service.GetByConnectionAsync(connectionId);
        return Results.Ok(favorites.Select(MapToDto));
    }

    private static async Task<IResult> Add(int connectionId, FavoriteEntityDto request, IConnectionRepository connections, IFavoriteEntityService service)
    {
        var error = Validate(request.EntityType, request.Name, request.TopicName);
        if (error != null)
        {
            return Results.BadRequest(new { error });
        }

        if (await connections.GetByIdAsync(connectionId) == null)
        {
            return Results.NotFound(new { error = "Connection not found" });
        }

        var favorite = await service.AddAsync(connectionId, request.EntityType, request.Name, NormalizeTopic(request.EntityType, request.TopicName));
        return Results.Ok(MapToDto(favorite));
    }

    private static async Task<IResult> Remove(int connectionId, string entityType, string name, string? topicName, IFavoriteEntityService service)
    {
        var error = Validate(entityType, name, topicName);
        if (error != null)
        {
            return Results.BadRequest(new { error });
        }

        await service.RemoveAsync(connectionId, entityType, name, NormalizeTopic(entityType, topicName));
        return Results.NoContent();
    }

    private static string? Validate(string? entityType, string? name, string? topicName)
    {
        if (string.IsNullOrEmpty(entityType) || !EntityTypes.Contains(entityType))
        {
            return "Entity type must be 'queue', 'topic' or 'subscription'";
        }
        if (string.IsNullOrWhiteSpace(name) || name.Length > MaxNameLength)
        {
            return "Entity name is required and must not exceed 260 characters";
        }
        if (entityType == "subscription" && (string.IsNullOrWhiteSpace(topicName) || topicName.Length > MaxNameLength))
        {
            return "Topic name is required for subscriptions and must not exceed 260 characters";
        }
        return null;
    }

    private static string? NormalizeTopic(string entityType, string? topicName) =>
        entityType == "subscription" ? topicName : null;

    private static FavoriteEntityDto MapToDto(FavoriteEntity favorite) => new()
    {
        EntityType = favorite.EntityType,
        Name = favorite.EntityName,
        TopicName = string.IsNullOrEmpty(favorite.TopicName) ? null : favorite.TopicName,
    };
}
