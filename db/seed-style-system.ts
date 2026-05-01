import "dotenv/config";
import { db } from "./index";
import { styleSystems } from "./schema";

const styles = [
  { code: "dramatic", name: "戏剧", nameEn: "Dramatic", category: "feminine", description: "大胆、醒目、充满张力的风格", characteristics: '["大胆","醒目","气场强"]', bestColors: '["正红色","宝蓝色","墨绿色"]', worstColors: '["pastel色","浅粉色"]', sortOrder: 1 },
  { code: "romantic_dramatic", name: "浪漫戏剧", nameEn: "Romantic Dramatic", category: "feminine", description: "柔美与大胆结合的风格", characteristics: '["柔美","大胆","张力"]', bestColors: '["酒红色","紫色系","亮金色"]', worstColors: '["荧光色","暗沉色"]', sortOrder: 2 },
  { code: "dramatic_natural", name: "戏剧自然", nameEn: "Dramatic Natural", category: "mixed", description: "大胆与随性结合的风格", characteristics: '["大胆","随性","自然"]', bestColors: '["军绿色","棕色","亮蓝"]', worstColors: '["过于柔和色"]', sortOrder: 3 },
  { code: "natural", name: "自然", nameEn: "Natural", category: "natural", description: "随性、舒适、亲和自然的风格", characteristics: '["随性","舒适","亲和"]', bestColors: '["大地色系","橄榄绿","陶土色"]', worstColors: '["荧光色","亮粉色"]', sortOrder: 4 },
  { code: "romantic_natural", name: "浪漫自然", nameEn: "Romantic Natural", category: "mixed", description: "柔美与自然结合的风格", characteristics: '["柔美","自然","亲和"]', bestColors: '["粉色系","大地色","绿色"]', worstColors: '["冷硬色"]', sortOrder: 5 },
  { code: "dramatic_classic", name: "戏剧经典", nameEn: "Dramatic Classic", category: "mixed", description: "大胆与端庄结合的风格", characteristics: '["大胆","端庄","精致"]', bestColors: '["藏青色","正红色","金色"]', worstColors: '["花哨色"]', sortOrder: 6 },
  { code: "classic", name: "经典", nameEn: "Classic", category: "classic", description: "端庄、精致、永恒优雅的风格", characteristics: '["端庄","精致","永恒"]', bestColors: '["藏青色","炭灰色","象牙白"]', worstColors: '["荧光色","花哨印花"]', sortOrder: 7 },
  { code: "romantic_classic", name: "浪漫经典", nameEn: "Romantic Classic", category: "mixed", description: "柔美与端庄结合的风格", characteristics: '["柔美","端庄","优雅"]', bestColors: '["珍珠白","淡紫","香槟金"]', worstColors: '["荧光色"]', sortOrder: 8 },
  { code: "dramatic_ingenue", name: "戏剧灵巧", nameEn: "Dramatic Ingenue", category: "mixed", description: "大胆与灵巧结合的风格", characteristics: '["大胆","灵巧","活泼"]', bestColors: '["亮蓝","粉色","黑色"]', worstColors: '["暗沉色"]', sortOrder: 9 },
  { code: "ingenue", name: "灵巧", nameEn: "Ingenue", category: "feminine", description: "灵巧、活泼、青春的风格", characteristics: '["灵巧","活泼","青春"]', bestColors: '["粉色系","淡蓝","白色"]', worstColors: '["暗沉色","过于正式色"]', sortOrder: 10 },
  { code: "romantic_ingenue", name: "浪漫灵巧", nameEn: "Romantic Ingenue", category: "mixed", description: "柔美与灵巧结合的风格", characteristics: '["柔美","灵巧","可爱"]', bestColors: '["粉色","淡紫","白色"]', worstColors: '["暗沉色"]', sortOrder: 11 },
  { code: "dramatic_romantic", name: "戏剧浪漫", nameEn: "Dramatic Romantic", category: "mixed", description: "大胆与柔美结合的风格", characteristics: '["大胆","柔美","张力"]', bestColors: '["深红色","紫色","黑色"]', worstColors: '["过于柔和色"]', sortOrder: 12 },
  { code: "romantic", name: "浪漫", nameEn: "Romantic", category: "feminine", description: "柔美、优雅、充满女性魅力的风格", characteristics: '["柔美","优雅","曲线感"]', bestColors: '["粉色系","紫色系","酒红色"]', worstColors: '["荧光色","暗沉棕色"]', sortOrder: 13 }
];

async function seed() {
  console.log("🌱 开始初始化 13 种风格数据...");
  try {
    await db.delete(styleSystems);
    await db.insert(styleSystems).values(styles);
    const result = await db.select().from(styleSystems);
    console.log(`✅ 成功插入 ${result.length} 种风格数据`);
    console.log("📊 风格列表:", result.map(s => s.name).join(", "));
  } catch (error) {
    console.error("❌ 失败:", error);
    process.exit(1);
  }
  process.exit(0);
}

seed();
