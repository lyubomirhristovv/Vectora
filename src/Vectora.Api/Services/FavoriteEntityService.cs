using Microsoft.EntityFrameworkCore;
using Vectora.Api.Data;
using Vectora.Api.Models;

namespace Vectora.Api.Services;

public class FavoriteEntityService : IFavoriteEntityService
{
    private readonly VectoraDbContext _db;

    public FavoriteEntityService(VectoraDbContext db)
    {
        _db = db;
    }

    public async Task<List<FavoriteEntity>> GetByConnectionAsync(int connectionId)
    {
        return await _db.FavoriteEntities
            .Where(x => x.ConnectionId == connectionId)
            .OrderBy(x => x.EntityType)
            .ThenBy(x => x.TopicName)
            .ThenBy(x => x.EntityName)
            .ToListAsync();
    }

    public async Task<FavoriteEntity> AddAsync(int connectionId, string entityType, string name, string? topicName)
    {
        var topic = topicName ?? string.Empty;
        var existing = await Find(connectionId, entityType, name, topic);
        if (existing != null)
        {
            return existing;
        }

        var favorite = new FavoriteEntity
        {
            ConnectionId = connectionId,
            EntityType = entityType,
            EntityName = name,
            TopicName = topic,
        };
        _db.FavoriteEntities.Add(favorite);
        await _db.SaveChangesAsync();
        return favorite;
    }

    public async Task<bool> RemoveAsync(int connectionId, string entityType, string name, string? topicName)
    {
        var existing = await Find(connectionId, entityType, name, topicName ?? string.Empty);
        if (existing == null)
        {
            return false;
        }

        _db.FavoriteEntities.Remove(existing);
        await _db.SaveChangesAsync();
        return true;
    }

    private Task<FavoriteEntity?> Find(int connectionId, string entityType, string name, string topicName) =>
        _db.FavoriteEntities.FirstOrDefaultAsync(x =>
            x.ConnectionId == connectionId &&
            x.EntityType == entityType &&
            x.EntityName == name &&
            x.TopicName == topicName);
}
