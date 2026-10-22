using Vectora.Api.Models;

namespace Vectora.Api.Services;

public interface IFavoriteEntityService
{
    Task<List<FavoriteEntity>> GetByConnectionAsync(int connectionId);
    Task<FavoriteEntity> AddAsync(int connectionId, string entityType, string name, string? topicName);
    Task<bool> RemoveAsync(int connectionId, string entityType, string name, string? topicName);
}
