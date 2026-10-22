using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Vectora.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddFavoriteEntities : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "FavoriteEntities",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    ConnectionId = table.Column<int>(type: "INTEGER", nullable: false),
                    EntityType = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    EntityName = table.Column<string>(type: "TEXT", maxLength: 260, nullable: false),
                    TopicName = table.Column<string>(type: "TEXT", maxLength: 260, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FavoriteEntities", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FavoriteEntities_Connections_ConnectionId",
                        column: x => x.ConnectionId,
                        principalTable: "Connections",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_FavoriteEntities_ConnectionId_EntityType_TopicName_EntityName",
                table: "FavoriteEntities",
                columns: new[] { "ConnectionId", "EntityType", "TopicName", "EntityName" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "FavoriteEntities");
        }
    }
}
