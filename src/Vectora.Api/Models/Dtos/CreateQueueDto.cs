namespace Vectora.Api.Models;

public class CreateQueueDto
{
    public string Name { get; set; } = string.Empty;
    public TimeSpan? DefaultMessageTimeToLive { get; set; }
    public TimeSpan? LockDuration { get; set; }
    public TimeSpan? AutoDeleteOnIdle { get; set; }
    public TimeSpan? DuplicateDetectionHistoryTimeWindow { get; set; }
    public int? MaxDeliveryCount { get; set; }
    public long? MaxSizeInMegabytes { get; set; }
    public bool? RequiresDuplicateDetection { get; set; }
    public bool? RequiresSession { get; set; }
    public bool? DeadLetteringOnMessageExpiration { get; set; }
    public bool? EnableBatchedOperations { get; set; }
    public bool? EnablePartitioning { get; set; }
    public string? ForwardTo { get; set; }
    public string? ForwardDeadLetteredMessagesTo { get; set; }
    public string? UserMetadata { get; set; }
}
