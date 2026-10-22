namespace Vectora.Api.Models;

public class FavoriteEntity
{
    public int Id { get; set; }
    public int ConnectionId { get; set; }

    // "queue", "topic" or "subscription".
    public required string EntityType { get; set; }
    public required string EntityName { get; set; }

    // Parent topic for subscriptions; empty (not null) otherwise so the unique index treats it as a value.
    public string TopicName { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
