// The unread count on the Windows taskbar button (GitHub#577). macOS draws the Dock badge from a
// number; Windows only takes a small picture laid over the app's taskbar icon (an "overlay icon"),
// so the app draws that picture itself: a red disc with the number in white, the same look as the
// Dock badge. Pure (no system call, no font): the shell hands the pixels to the window.

/// The picture's side, in pixels (the system scales it to the taskbar's overlay size).
pub const SIZE: u32 = 32;
/// The disc's colour (the Dock badge's red) and the number's.
pub const RED: [u8; 4] = [0xe5, 0x3e, 0x3e, 0xff];
pub const WHITE: [u8; 4] = [0xff, 0xff, 0xff, 0xff];

/// 3 × 5 glyphs, one row per entry, the top bit of 3 = the left column.
fn glyph(c: char) -> [u8; 5] {
    match c {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

/// What the badge says: the count, or "99+" above 99. None: nothing to show.
pub fn text(count: i64) -> Option<String> {
    match count {
        n if n <= 0 => None,
        n if n > 99 => Some("99+".into()),
        n => Some(n.to_string()),
    }
}

/// The overlay picture for `count` unread items: RGBA rows, SIZE × SIZE. None for 0 (no overlay).
pub fn overlay(count: i64) -> Option<Vec<u8>> {
    let text = text(count)?;
    let n = SIZE as i32;
    let mut px = vec![0u8; (SIZE * SIZE * 4) as usize];
    let put = |px: &mut Vec<u8>, x: i32, y: i32, c: [u8; 4]| {
        if (0..n).contains(&x) && (0..n).contains(&y) {
            let i = ((y * n + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&c);
        }
    };
    // the disc: every pixel whose centre lies within the radius
    let r = n as f64 / 2.0;
    for y in 0..n {
        for x in 0..n {
            let (dx, dy) = (x as f64 + 0.5 - r, y as f64 + 0.5 - r);
            if dx * dx + dy * dy <= r * r {
                put(&mut px, x, y, RED);
            }
        }
    }
    // the number, centred: bigger for one or two characters, smaller for "99+"
    let chars: Vec<char> = text.chars().collect();
    let scale: i32 = if chars.len() <= 2 { 3 } else { 2 };
    let w = chars.len() as i32 * 3 * scale + (chars.len() as i32 - 1) * scale;
    let h = 5 * scale;
    let (x0, y0) = ((n - w) / 2, (n - h) / 2);
    for (k, ch) in chars.iter().enumerate() {
        let gx = x0 + k as i32 * 4 * scale;
        for (row, bits) in glyph(*ch).iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    for sy in 0..scale {
                        for sx in 0..scale {
                            put(&mut px, gx + col * scale + sx, y0 + row as i32 * scale + sy, WHITE);
                        }
                    }
                }
            }
        }
    }
    Some(px)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(px: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    fn white(px: &[u8]) -> usize {
        px.chunks(4).filter(|p| *p == WHITE).count()
    }

    #[test]
    fn nothing_unread_is_no_overlay() {
        assert_eq!(overlay(0), None);
        assert_eq!(overlay(-3), None);
        assert_eq!(text(0), None);
    }

    #[test]
    fn the_number_as_the_dock_says_it_and_99_plus_above() {
        assert_eq!(text(1).as_deref(), Some("1"));
        assert_eq!(text(42).as_deref(), Some("42"));
        assert_eq!(text(99).as_deref(), Some("99"));
        assert_eq!(text(100).as_deref(), Some("99+"));
        assert_eq!(text(12_345).as_deref(), Some("99+"));
    }

    #[test]
    fn a_red_disc_on_a_clear_square_with_the_number_in_white() {
        let px = overlay(7).unwrap();
        assert_eq!(px.len(), (SIZE * SIZE * 4) as usize);
        // corners clear, the edge of the disc red, the middle has the number
        for (x, y) in [(0, 0), (SIZE - 1, 0), (0, SIZE - 1), (SIZE - 1, SIZE - 1)] {
            assert_eq!(at(&px, x, y)[3], 0, "corner {x},{y}");
        }
        assert_eq!(at(&px, SIZE / 2, 1), RED);
        assert_eq!(at(&px, 1, SIZE / 2), RED);
        assert!(white(&px) > 0);
        // every number pixel is inside the disc (never cut off at the square's edge)
        for y in 0..SIZE {
            for x in 0..SIZE {
                if at(&px, x, y) == WHITE {
                    let (dx, dy) = (x as f64 + 0.5 - 16.0, y as f64 + 0.5 - 16.0);
                    assert!(dx * dx + dy * dy < 16.0 * 16.0, "{x},{y}");
                }
            }
        }
    }

    #[test]
    fn each_count_draws_its_own_picture() {
        let all: Vec<Vec<u8>> = [1, 2, 7, 8, 10, 11, 42, 99, 100].iter().map(|n| overlay(*n).unwrap()).collect();
        for i in 0..all.len() {
            for j in i + 1..all.len() {
                assert_ne!(all[i], all[j], "{i} vs {j}");
            }
        }
        // the same count, the same picture (nothing random in it)
        assert_eq!(overlay(42), overlay(42));
        // "99+" and anything above it look the same
        assert_eq!(overlay(100), overlay(5000));
        // a one-digit number in big strokes: "1" is 3 px wide strokes
        assert_eq!(white(&overlay(1).unwrap()), 8 * 9);
    }
}
